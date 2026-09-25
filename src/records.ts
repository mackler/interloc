// The program's own records on disk, in their version-2 shape, with readers that also accept the
// version-1 files of earlier runs and a converter for archives (findings 6, 7, 9 and 15 of
// docs/functional-design-review.md; decision Q5 and its follow-up). The value schemas of the entries
// are in src/schema.ts; this module holds the file shapes, the version-1 shapes, and the readers.

import { Effect, FileSystem, Path, type PlatformError, Result, Schema } from "effect";
import { type Artifact, LOG_SUBJECTS, pathOf, phaseOf, type SubjectId, subjectOf } from "./artifacts.ts";
import { FileSystemError, type RoundInvalid, StateFileInvalid } from "./errors.ts";
import { historyBefore, validateReview, validateRound } from "./round.ts";
import * as S from "./schema.ts";
import type { IssueId, LogEntry, PlannerResponse, QuestionsFile, Review, UsageRecord } from "./schema.ts";
import { decodeRecord, parseJson } from "./state.ts";

/** The version written by this program. A file or line without a version marker is version 1. */
export const VERSION = 2;
const V2 = Schema.Literal(2);
const Strings = Schema.Array(Schema.String);

// ---- version 2 files ------------------------------------------------------------------------------

export const LogFile = Schema.Struct({ version: V2, entries: Schema.Array(S.LogEntry) });
export type LogFile = typeof LogFile.Type;
export const logFile = (entries: readonly LogEntry[]): LogFile => ({ version: VERSION, entries });
export const questionsFile = (task: string, questions: QuestionsFile["questions"]): QuestionsFile => ({ version: VERSION, task, questions });

const IssueRecord = Schema.Struct({ id: S.IssueId, severity: S.Severity, location: Schema.String, problem: Schema.String, evidence: Schema.String });
export const ValidatedReviewRecord = Schema.Struct({ issues: Schema.Array(IssueRecord) });
const DispositionRecord = Schema.Struct({ id: S.IssueId, action: S.Action, rationale: Schema.String, duplicateOf: Schema.NullOr(S.IssueId), reverses: Schema.NullOr(S.IssueId) });
const SelfCorrectionRecord = Schema.Struct({ id: S.IssueId, newAction: Schema.Literals(["accepted", "rejected", "plan_error"]), explanation: Schema.String, generated: Schema.Boolean });
const NoteRecord = Schema.Struct({ id: S.IssueId, field: Schema.Literals(["duplicate_of", "reverses"]), named: Schema.String, reason: Schema.Literals(["unknown", "not_accepted"]) });
/** The response part of a validated round (src/round.ts `ValidatedRound` without its review). */
export const ValidatedResponseRecord = Schema.Struct({
  dispositions: Schema.Array(DispositionRecord),
  selfCorrections: Schema.Array(SelfCorrectionRecord),
  reviewerFeedback: Schema.String,
  questionsForUser: Strings,
});
const ProblemsRecord = Schema.Struct({ duplicateIssues: Strings, missing: Strings, duplicateDispositions: Strings, unknownDispositions: Strings, emptyIds: Strings, collidingIds: Strings });
/** `subject` is the subject directory (question-review, requirements-review, planning-<k>); `reconstructed` marks a record the converter built from a version-1 pair. */
const roundBase = { subject: Schema.String, phase: S.NonNegativeInt, round: S.NonNegativeInt, reconstructed: Schema.Boolean };
const validatedFields = { kind: Schema.Literal("validated"), ...roundBase, review: ValidatedReviewRecord, response: ValidatedResponseRecord, notes: Schema.Array(NoteRecord) };
const noResponseFields = { kind: Schema.Literal("no_response"), ...roundBase, review: ValidatedReviewRecord };
const invalidFields = { kind: Schema.Literal("invalid"), ...roundBase, review: S.Review, response: Schema.NullOr(S.PlannerResponse), problems: ProblemsRecord };
/** One round of a subject: completed and validated, without a response (converged or interrupted), or invalid (only ever reconstructed). */
export const RoundRecord = Schema.Union([Schema.Struct(validatedFields), Schema.Struct(noResponseFields), Schema.Struct(invalidFields)]);
export const RoundFile = Schema.Union([Schema.Struct({ version: V2, ...validatedFields }), Schema.Struct({ version: V2, ...noResponseFields }), Schema.Struct({ version: V2, ...invalidFields })]);
export type RoundRecord = typeof RoundRecord.Type;

// ---- version 1 (the shapes before Q5) ------------------------------------------------------------

export const LogEntryV1 = Schema.Struct({
  id: Schema.NonEmptyString,
  phase: S.NonNegativeInt,
  round: S.NonNegativeInt,
  source: Schema.Literals(["review", "self_correction", "user"]),
  severity: Schema.optionalKey(S.Severity),
  location: Schema.optionalKey(Schema.String),
  problem: Schema.String,
  evidence: Schema.optionalKey(Schema.String),
  action: Schema.String,
  rationale: Schema.String,
  duplicate_of: Schema.optionalKey(Schema.String),
  reverses: Schema.optionalKey(Schema.String),
  superseded: Schema.optionalKey(Schema.Boolean),
});
const LogFileV1 = Schema.Array(LogEntryV1);
/** A version-1 usage line: the fields differed per agent and were all optional; excess properties were ignored. */
export const UsageEntryV1 = Schema.Struct({
  time: Schema.String,
  agent: Schema.Literals(["claude", "codex"]),
  session_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  thread_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  num_turns: Schema.optionalKey(S.NonNegativeInt),
  total_cost_usd: Schema.optionalKey(Schema.NullOr(S.NonNegativeFinite)),
  usage: Schema.optionalKey(Schema.NullOr(Schema.Struct({ input_tokens: Schema.optionalKey(S.NonNegativeInt), output_tokens: Schema.optionalKey(S.NonNegativeInt) }))),
});
const QuestionsFileV1 = Schema.Struct({ task: S.QuestionsFile.fields.task, questions: S.QuestionsFile.fields.questions });

const REVIEW_ACTIONS: ReadonlySet<string> = new Set(["accepted", "partially_accepted", "rejected", "no_change_needed", "clarification_requested"]);
const SELF_ACTIONS: ReadonlySet<string> = new Set(["accepted", "plan_error", "correction_disputed"]);
const invalid = (file: string, message: string, at: string): Result.Result<never, StateFileInvalid> => Result.fail(new StateFileInvalid({ file, message: `${message} (at ${at})` }));
const reference = (named: string | undefined): IssueId | null => (named === undefined || named === "" ? null : (named as IssueId));

/** A version-1 entry in its version-2 shape; a value that the version-2 shape cannot hold is StateFileInvalid. */
const convertLogEntry = (file: string, index: number, e: typeof LogEntryV1.Type): Result.Result<LogEntry, StateFileInvalid> => {
  const at = (field: string) => `[${index}].${field}`;
  const base = { id: e.id as IssueId, phase: e.phase, round: e.round, problem: e.problem, rationale: e.rationale, superseded: e.superseded === true };
  switch (e.source) {
    case "review": {
      if (e.severity === undefined) return invalid(file, "a review entry without severity", at("severity"));
      if (e.location === undefined) return invalid(file, "a review entry without location", at("location"));
      if (e.evidence === undefined) return invalid(file, "a review entry without evidence", at("evidence"));
      if (!REVIEW_ACTIONS.has(e.action)) return invalid(file, `Unknown action ${JSON.stringify(e.action)} of a review entry`, at("action"));
      return Result.succeed({ ...base, source: "review", severity: e.severity, location: e.location, evidence: e.evidence, action: e.action as S.Action, duplicate_of: reference(e.duplicate_of), reverses: reference(e.reverses) });
    }
    case "self_correction":
      if (!SELF_ACTIONS.has(e.action)) return invalid(file, `Unknown action ${JSON.stringify(e.action)} of a self-correction entry`, at("action"));
      return Result.succeed({ ...base, source: "self_correction", action: e.action as "accepted" | "plan_error" | "correction_disputed" });
    case "user":
      if (e.action !== "decided_by_user") return invalid(file, `Unknown action ${JSON.stringify(e.action)} of a user entry`, at("action"));
      return Result.succeed({ ...base, source: "user", action: "decided_by_user" });
  }
};

const all = <A, E>(results: readonly Result.Result<A, E>[]): Result.Result<readonly A[], E> => {
  const values: A[] = [];
  for (const r of results) {
    if (Result.isFailure(r)) return Result.fail(r.failure);
    values.push(r.success);
  }
  return Result.succeed(values);
};
const isVersion2 = (json: unknown): boolean => typeof json === "object" && json !== null && !Array.isArray(json) && (json as { version?: unknown }).version === VERSION;

// ---- readers (both versions) ---------------------------------------------------------------------

/** The entries of a log file: a version-2 object, or a version-1 array converted on read. */
export const readLog = (file: string, text: string): Result.Result<readonly LogEntry[], StateFileInvalid> => {
  const json = parseJson(file, text);
  if (Result.isFailure(json)) return Result.fail(json.failure);
  if (!Array.isArray(json.success)) {
    const decoded = decodeRecord(file, LogFile, json.success);
    return Result.isSuccess(decoded) ? Result.succeed(decoded.success.entries) : Result.fail(decoded.failure);
  }
  const v1 = decodeRecord(file, LogFileV1, json.success);
  return Result.isSuccess(v1) ? all(v1.success.map((e, i) => convertLogEntry(file, i, e))) : Result.fail(v1.failure);
};

const convertUsage = (e: typeof UsageEntryV1.Type): UsageRecord =>
  e.agent === "claude"
    ? { version: VERSION, agent: "claude", time: e.time, session: e.session_id ?? null, num_turns: e.num_turns ?? null, total_cost_usd: e.total_cost_usd ?? null }
    : { version: VERSION, agent: "codex", time: e.time, thread: e.thread_id ?? null, input_tokens: e.usage?.input_tokens ?? 0, output_tokens: e.usage?.output_tokens ?? 0 };

/** The lines of usage.jsonl as version-2 records; a version-1 line is converted (its excess fields, which the SDKs decide, are dropped). */
export const readUsage = (file: string, text: string): Result.Result<readonly UsageRecord[], StateFileInvalid> => {
  const lines = text.split("\n").filter((l) => l !== "");
  const atLine = (index: number, r: Result.Result<UsageRecord, StateFileInvalid>): Result.Result<UsageRecord, StateFileInvalid> =>
    Result.isFailure(r) ? Result.fail(new StateFileInvalid({ file, message: `line ${index + 1}: ${r.failure.message}` })) : r;
  return all(
    lines.map((line, i) => {
      const json = parseJson(file, line);
      if (Result.isFailure(json)) return atLine(i, Result.fail(json.failure));
      if (isVersion2(json.success)) return atLine(i, decodeRecord(file, S.UsageRecord, json.success));
      const v1 = decodeRecord(file, UsageEntryV1, json.success, { onExcessProperty: "ignore" });
      return atLine(i, Result.isSuccess(v1) ? Result.succeed(convertUsage(v1.success)) : Result.fail(v1.failure));
    }),
  );
};

/** questions.json as its version-2 file; a version-1 file gets the marker. */
export const readQuestions = (file: string, text: string): Result.Result<QuestionsFile, StateFileInvalid> => {
  const json = parseJson(file, text);
  if (Result.isFailure(json)) return Result.fail(json.failure);
  if (isVersion2(json.success)) return decodeRecord(file, S.QuestionsFile, json.success);
  const v1 = decodeRecord(file, QuestionsFileV1, json.success);
  return Result.isSuccess(v1) ? Result.succeed(questionsFile(v1.success.task, v1.success.questions)) : Result.fail(v1.failure);
};

// ---- rounds ---------------------------------------------------------------------------------------

export type RecordsError = StateFileInvalid | FileSystemError;
type Fs = FileSystem.FileSystem | Path.Path;

const problemsOf = (e: RoundInvalid): typeof ProblemsRecord.Type => ({
  duplicateIssues: e.duplicateIssues,
  missing: e.missing,
  duplicateDispositions: e.duplicateDispositions,
  unknownDispositions: e.unknownDispositions,
  emptyIds: e.emptyIds,
  collidingIds: e.collidingIds,
});

/** A version-1 round (the review and the optional response) validated against its pre-round history. Pure. */
export const reconstructRound = (subject: string, phase: number, round: number, review: Review, response: PlannerResponse | null, history: readonly LogEntry[]): RoundRecord => {
  const base = { subject, phase, round, reconstructed: true };
  const checked = validateReview(review);
  if (Result.isFailure(checked)) return { kind: "invalid", ...base, review, response, problems: problemsOf(checked.failure) };
  if (response === null) return { kind: "no_response", ...base, review: checked.success };
  const validated = validateRound(checked.success, response, history, phase, round);
  if (Result.isFailure(validated)) return { kind: "invalid", ...base, review, response, problems: problemsOf(validated.failure) };
  const v = validated.success;
  return { kind: "validated", ...base, review: v.review, response: { dispositions: v.dispositions, selfCorrections: v.selfCorrections, reviewerFeedback: v.reviewerFeedback, questionsForUser: v.questionsForUser }, notes: v.notes };
};

const io = <A>(operation: string, file: string, effect: Effect.Effect<A, PlatformError.PlatformError>): Effect.Effect<A, FileSystemError> =>
  Effect.mapError(effect, (e) => new FileSystemError({ operation, path: file, message: e.message }));
const files = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (file: string) => io("read", file, fs.exists(file));
  const readText = (file: string) => io("read", file, fs.readFileString(file));
  const readJson = <Out extends Schema.ConstraintDecoder<unknown>>(file: string, schema: Out, options?: { readonly onExcessProperty: "ignore" | "error" }) =>
    readText(file).pipe(Effect.flatMap((text) => Effect.fromResult(parseJson(file, text))), Effect.flatMap((json) => Effect.fromResult(decodeRecord(file, schema, json, options))));
  const readIfExists = <A>(file: string, read: (file: string) => Effect.Effect<A, RecordsError>): Effect.Effect<A | null, RecordsError> =>
    exists(file).pipe(Effect.flatMap((present) => (present ? read(file) : Effect.succeed(null))));
  return { fs, path, exists, readText, readJson, readIfExists };
});

/**
 * The record of round `round` of a subject directory: `round-<n>.json` when the program wrote one, else the
 * version-1 pair `review-<n>.json` + optional `cc-<n>.json` reconstructed against the log as it was before
 * the round (`historyBefore`). Agent replies are decoded with excess properties ignored.
 */
export const readRound = (runDir: string, subject: string, round: number): Effect.Effect<RoundRecord, RecordsError, Fs> =>
  Effect.gen(function* () {
    const { path, readJson, readIfExists, readText } = yield* files;
    const dir = path.join(runDir, subject);
    const id = subjectOf(subject);
    if (id === null) return yield* Effect.fail(new StateFileInvalid({ file: dir, message: "not a subject directory of a run (question-review, requirements-review or planning-<k>)" }));
    const written = yield* readIfExists(path.join(runDir, pathOf({ kind: "round", subject: id, round })), (file) => readJson(file, RoundFile));
    if (written !== null) {
      const { version: _version, ...record } = written;
      return record as RoundRecord;
    }
    const lenient = { onExcessProperty: "ignore" as const };
    const review = yield* readJson(path.join(runDir, pathOf({ kind: "review", subject: id, round })), S.Review, lenient);
    const response = yield* readIfExists(path.join(runDir, pathOf({ kind: "response", subject: id, round })), (file) => readJson(file, S.PlannerResponse, lenient));
    const logFile = path.join(runDir, pathOf({ kind: "log", subject: id }));
    const log = (yield* readIfExists(logFile, (file) => readText(file).pipe(Effect.flatMap((text) => Effect.fromResult(readLog(file, text)))))) ?? [];
    const phase = phaseOf(id);
    return reconstructRound(subject, phase, round, review, response, historyBefore(log, phase, round));
  });

// ---- checkpoint (finding 16; Q6) --------------------------------------------------------------------

/** The stage of the last committed transition; `started` is written by `init`. */
export const CheckpointStage = Schema.Literals(["started", "reviewed", "responded", "logged", "decided", "executed"]);
export const Checkpoint = Schema.Struct({ version: V2, subject: Schema.String, phase: S.NonNegativeInt, round: S.NonNegativeInt, stage: CheckpointStage, time: Schema.String });
export type Checkpoint = typeof Checkpoint.Type;
/** What the procedure reports as committed; the store adds the version and the time. */
export type CheckpointPoint = Readonly<{ subject: string; phase: number; round: number; stage: Checkpoint["stage"] }>;

/**
 * The checkpoint of a run directory, verified: the records the named transition implies exist and decode
 * (review and round record from `reviewed` on, the response from `responded` on, the log for `logged`, the
 * execution result for `executed`); null when there is no checkpoint file.
 */
export const readCheckpoint = (runDir: string): Effect.Effect<Checkpoint | null, RecordsError, Fs> =>
  Effect.gen(function* () {
    const { path, exists, readJson, readIfExists, readText } = yield* files;
    const file = path.join(runDir, pathOf({ kind: "checkpoint" }));
    const checkpoint = yield* readIfExists(file, (f) => readJson(f, Checkpoint));
    if (checkpoint === null) return null;
    const invalid = (what: string) => Effect.fail(new StateFileInvalid({ file, message: `the checkpoint names ${what}` }));
    const lenient = { onExcessProperty: "ignore" as const };
    const required = <Out extends Schema.ConstraintDecoder<unknown>>(artifact: Artifact, schema: Out, options?: typeof lenient): Effect.Effect<Out["Type"], RecordsError> => {
      const target = path.join(runDir, pathOf(artifact));
      return exists(target).pipe(Effect.flatMap((present) => (present ? readJson(target, schema, options) : invalid(`a missing record: ${pathOf(artifact)}`))));
    };
    const logDecodes = (subject: SubjectId) => {
      const log = path.join(runDir, pathOf({ kind: "log", subject }));
      return exists(log).pipe(Effect.flatMap((present) => (present ? readText(log).pipe(Effect.flatMap((text) => Effect.fromResult(readLog(log, text)))) : invalid(`a missing log: ${pathOf({ kind: "log", subject })}`))));
    };
    switch (checkpoint.stage) {
      case "started":
        for (const subject of LOG_SUBJECTS) yield* logDecodes(subject);
        break;
      case "executed":
        yield* required({ kind: "execution", phase: checkpoint.phase }, S.ExecOutcome);
        break;
      default: {
        const subject = subjectOf(checkpoint.subject);
        if (subject === null) return yield* invalid(`an unknown subject directory: ${checkpoint.subject}`);
        const { round, stage } = checkpoint;
        yield* required({ kind: "review", subject, round }, S.Review, lenient);
        const record = yield* required({ kind: "round", subject, round }, RoundFile);
        if (stage === "responded" || stage === "logged") {
          yield* required({ kind: "response", subject, round }, S.PlannerResponse, lenient);
          if (record.kind !== "validated") return yield* invalid(`a ${stage} round whose record is ${record.kind}`);
        }
        if (stage === "logged" || stage === "decided") yield* logDecodes(subject);
      }
    }
    return checkpoint;
  });

/** What the converter changed: the files it wrote, relative to the run directory. */
export type Conversion = Readonly<{ written: readonly string[] }>;
const LOG_FILES = LOG_SUBJECTS.map((subject) => pathOf({ kind: "log", subject }));
const REVIEW_FILE = /^review-([1-9][0-9]*)\.json$/;
const render = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

/**
 * Rewrites every version-1 file of a run directory (or an archive) to version 2: the three logs, usage.jsonl,
 * questions.json, and one `round-<n>.json` per `review-<n>.json` of every subject directory. A file whose
 * version-2 text is already in place is not written again, so a second run changes nothing; the agents'
 * replies (`review-<n>.json`, `cc-<n>.json`, `cc-0.json`) and `execution-<k>/result.json` are never touched.
 * An existing `round-<n>.json` is kept: the program's own record is not replaced by a reconstruction.
 */
export const convertPlanReviewDir = (runDir: string): Effect.Effect<Conversion, RecordsError, Fs> =>
  Effect.gen(function* () {
    const { fs, path, exists, readText, readIfExists } = yield* files;
    const written: string[] = [];
    const writeIfChanged = (file: string, text: string) =>
      Effect.gen(function* () {
        if ((yield* exists(file)) && (yield* readText(file)) === text) return;
        yield* io("write", file, fs.writeFileString(file, text));
        written.push(path.relative(runDir, file));
      });
    const convertText = <A>(name: string, read: (file: string, text: string) => Result.Result<A, StateFileInvalid>, toText: (value: A) => string) =>
      Effect.gen(function* () {
        const file = path.join(runDir, name);
        const text = yield* readIfExists(file, readText);
        if (text === null) return;
        yield* writeIfChanged(file, toText(yield* Effect.fromResult(read(file, text))));
      });

    for (const name of LOG_FILES) yield* convertText(name, readLog, (entries) => render(logFile(entries)));
    yield* convertText(pathOf({ kind: "usage" }), readUsage, (records) => records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    yield* convertText(pathOf({ kind: "questions" }), readQuestions, render);

    const names = yield* io("list", runDir, fs.readDirectory(runDir));
    for (const name of names.filter((n) => subjectOf(n) !== null).sort()) {
      const dir = path.join(runDir, name);
      const info = yield* io("read", dir, fs.stat(dir));
      if (info.type !== "Directory") continue;
      const rounds = (yield* io("list", dir, fs.readDirectory(dir))).flatMap((f) => (REVIEW_FILE.test(f) ? [Number(REVIEW_FILE.exec(f)![1])] : [])).sort((a, b) => a - b);
      for (const n of rounds) {
        const file = path.join(runDir, pathOf({ kind: "round", subject: subjectOf(name)!, round: n }));
        if (yield* exists(file)) continue;
        const record = yield* readRound(runDir, name, n);
        yield* writeIfChanged(file, render({ version: VERSION, ...record }));
      }
    }
    return { written };
  });
