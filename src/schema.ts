// One definition per kind of data exchanged with the agents or kept on disk: it gives the type
// (`typeof X.Type`), the JSON Schema for the agents (src/jsonSchema.ts) and runtime validation.
// Replaces src/types.ts and src/schemas.ts. API names: docs/effect-v4-api.md.

import { Schema, SchemaIssue, Struct } from "effect";

export const Severity = Schema.Literals(["blocking", "major", "minor"]);

export const Issue = Schema.Struct({
  id: Schema.String,
  severity: Severity,
  location: Schema.String,
  problem: Schema.String,
  evidence: Schema.String,
});

export const Review = Schema.Struct({ issues: Schema.Array(Issue) });

export const Action = Schema.Literals([
  "accepted",
  "partially_accepted",
  "rejected",
  "no_change_needed",
  "clarification_requested",
]);

export const Disposition = Schema.Struct({
  id: Schema.String,
  action: Action,
  rationale: Schema.String,
  duplicate_of: Schema.String,
  reverses: Schema.String,
});

export const SelfCorrection = Schema.Struct({
  id: Schema.String,
  new_action: Schema.Literals(["accepted", "rejected", "plan_error"]),
  explanation: Schema.String,
});

/** The fields that every response to a review has. Spread into the question-list response. */
const plannerResponseFields = {
  dispositions: Schema.Array(Disposition),
  self_corrections: Schema.Array(SelfCorrection),
  reviewer_feedback: Schema.String,
  questions_for_user: Schema.Array(Schema.String),
};

export const PlannerResponse = Schema.Struct(plannerResponseFields);

export const PlanWriteResult = Schema.Struct({ questions_for_user: Schema.Array(Schema.String) });

/** One entry of the question list that Claude Code and Codex agree on before the interview. */
export const QuestionEntry = Schema.Struct({
  id: Schema.String,
  question: Schema.String,
  reason: Schema.String,
  proposed_answers: Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String })),
  default_answer: Schema.String,
});

export const QuestionList = Schema.Struct({ questions: Schema.Array(QuestionEntry) });

/** A response to a review of the question list: the dispositions and the complete amended list. */
export const QuestionListResponse = Schema.Struct({
  ...plannerResponseFields,
  questions: Schema.Array(QuestionEntry),
});

/** Claude Code's output for one turn of the interview. */
export const InterviewTurn = Schema.Struct({
  message_to_user: Schema.String,
  answered_ids: Schema.Array(Schema.String),
  complete: Schema.Boolean,
  summary: Schema.String,
});

export const ExecReport = Schema.Struct({
  status: Schema.Literals(["finished", "needs_input", "blocked"]),
  summary: Schema.String,
  question: Schema.String,
  remaining_work: Schema.String,
});

export const ExecOutcome = Schema.Struct({
  status: Schema.Literals(["finished", "needs_input", "blocked", "aborted"]),
  summary: Schema.String,
  question: Schema.String,
  remainingWork: Schema.String,
  // Set when the user's input was already read during the phase (a question from Claude Code).
  userInput: Schema.NullOr(Schema.String),
});

// Constraints for the program's own records (finding 5 of docs/functional-design-review.md). The seven agent
// schemas are unchanged, so the JSON Schema the agents receive is unchanged.
const safeInteger = Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER);
/** An integer ≥ 1 within the safe range: round limits. */
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), safeInteger);
/** An integer ≥ 0 within the safe range: phases, rounds, turn and token counts. */
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), safeInteger);
/** A finite number ≥ 0: costs. */
export const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** An issue id: a non-empty identifier, never prose (recommendation B). */
export const IssueId = Schema.NonEmptyString.pipe(Schema.brand("IssueId"));
export type IssueId = typeof IssueId.Type;

/** The fields every entry of an issue log has. `superseded` is required (Q5): true when a later entry has the same id. */
const logEntryBase = { id: IssueId, phase: NonNegativeInt, round: NonNegativeInt, problem: Schema.String, rationale: Schema.String, superseded: Schema.Boolean };
/** An issue Codex raised, with Claude Code's disposition; a reference names an earlier issue or is null. */
export const ReviewEntry = Schema.Struct({
  ...logEntryBase,
  source: Schema.Literal("review"),
  severity: Severity,
  location: Schema.String,
  evidence: Schema.String,
  action: Action,
  duplicate_of: Schema.NullOr(IssueId),
  reverses: Schema.NullOr(IssueId),
});
/** A correction Claude Code made to its own earlier work. */
export const SelfCorrectionEntry = Schema.Struct({ ...logEntryBase, source: Schema.Literal("self_correction"), action: Schema.Literals(["accepted", "plan_error", "correction_disputed"]) });
/** A decision of the user on one issue. */
export const UserEntry = Schema.Struct({ ...logEntryBase, source: Schema.Literal("user"), action: Schema.Literal("decided_by_user") });
/** One entry of an issue log, tagged by `source` (finding 6; Q5). */
export const LogEntry = Schema.Union([ReviewEntry, SelfCorrectionEntry, UserEntry]);

export const Config = Schema.Struct({
  questionPhase: Schema.Boolean,
  /** Paths relative to the project that the change detection ignores. A directory covers everything below it. */
  ignorePaths: Schema.Array(Schema.String),
  maxRounds: PositiveInt,
  maxIdleRounds: PositiveInt,
  countMinor: Schema.Boolean,
  execPermissionMode: Schema.Literals(["auto", "acceptEdits", "bypassPermissions", "default"]),
  claudeModel: Schema.NullOr(Schema.String),
  codexModel: Schema.NullOr(Schema.String),
});

/** A config file: any subset of the keys of Config. Unknown keys are rejected where it is decoded. */
export const PartialConfig = Config.mapFields(Struct.map(Schema.optionalKey));

/** plan-review/questions.json: the task and the agreed list. Unlike the agent schema, an entry's id must not be empty. */
export const QuestionsFile = Schema.Struct({
  version: Schema.Literal(2),
  task: Schema.String,
  /** A default that named none of the proposed answers is null (step 4.6). */
  questions: Schema.Array(Schema.Struct({ ...QuestionEntry.fields, id: Schema.NonEmptyString, default_answer: Schema.NullOr(Schema.String) })),
});

/** One line of plan-review/usage.jsonl, version 2: the fields the program reads, per agent (finding 9; Q5). */
export const ClaudeUsage = Schema.Struct({
  version: Schema.Literal(2),
  agent: Schema.Literal("claude"),
  time: Schema.String,
  session: Schema.NullOr(Schema.String),
  num_turns: Schema.NullOr(NonNegativeInt),
  total_cost_usd: Schema.NullOr(NonNegativeFinite),
});
export const CodexUsage = Schema.Struct({
  version: Schema.Literal(2),
  agent: Schema.Literal("codex"),
  time: Schema.String,
  thread: Schema.NullOr(Schema.String),
  input_tokens: NonNegativeInt,
  output_tokens: NonNegativeInt,
});
export const UsageRecord = Schema.Union([ClaudeUsage, CodexUsage]);

// The types, under the names the program used before the schemas existed.
export type Severity = typeof Severity.Type;
export type Issue = typeof Issue.Type;
export type Review = typeof Review.Type;
export type Action = typeof Action.Type;
export type Disposition = typeof Disposition.Type;
export type SelfCorrection = typeof SelfCorrection.Type;
export type PlannerResponse = typeof PlannerResponse.Type;
export type PlanWriteResult = typeof PlanWriteResult.Type;
export type QuestionEntry = typeof QuestionEntry.Type;
export type QuestionList = typeof QuestionList.Type;
export type QuestionListResponse = typeof QuestionListResponse.Type;
export type InterviewTurn = typeof InterviewTurn.Type;
export type ExecReport = typeof ExecReport.Type;
export type ExecOutcome = typeof ExecOutcome.Type;
export type LogEntry = typeof LogEntry.Type;
export type ReviewEntry = typeof ReviewEntry.Type;
export type Config = typeof Config.Type;
export type QuestionsFile = typeof QuestionsFile.Type;
export type UsageRecord = typeof UsageRecord.Type;

/** The first problem of a failed decode: the field path (`a.b[0]`, or "" at the root) and the message. */
export const firstIssue = (error: Schema.SchemaError): { path: string; message: string } => {
  const { issues } = formatIssue(error.issue);
  const first = issues[0];
  // A segment is a key, or an object that carries the key (Standard Schema's PathSegment).
  const keys = Array.from(first?.path ?? [], (segment) => (typeof segment === "object" && segment !== null ? segment.key : segment));
  const path = keys.map((key, i) => (typeof key === "number" ? `[${key}]` : i === 0 ? String(key) : `.${String(key)}`)).join("");
  return { path, message: first?.message ?? error.message };
};
const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1({ leafHook: SchemaIssue.defaultLeafHook });

export const defaultConfig: Config = {
  questionPhase: true,
  ignorePaths: [],
  maxRounds: 5,
  maxIdleRounds: 2,
  countMinor: true,
  execPermissionMode: "auto",
  claudeModel: null,
  codexModel: null,
};
