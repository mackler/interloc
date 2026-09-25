// The Store service on the platform services: the files in <project>/plan-review/ and the
// comparison of the project state (decoded and compared by src/snapshot.ts).
// API names: docs/effect-v4-api.md.

import { Cause, Clock, Effect, Exit, FileSystem, Layer, Option, Path, type PlatformError, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createHash } from "node:crypto";
import { type Artifact, LOG_SUBJECTS, pathOf, recordPath, reviewedFile, type SubjectId } from "./artifacts.ts";
import { FileSystemError, GitError } from "./errors.ts";
import type { LogEntry, UsageRecord } from "./schema.ts";
import type { Platform } from "./platform.ts";
import { type CheckpointPoint, questionsFile, readLog, readQuestions, readUsage, VERSION } from "./records.ts";
import { renderDecision, renderFeedback, subjectHeading } from "./render.ts";
import { type ProjectPath, type RecordPath, Store, type StoreError, type StoreShape } from "./services.ts";
import { decodeStatusV2, excluded, type Snapshot, type WorkingTreeEntry } from "./snapshot.ts";

/** The store of one project. `ignorePaths` are the paths the change detection ignores (config). */
export const makeStore = (projectDir: string, ignorePaths: readonly string[]): Effect.Effect<StoreShape, never, Platform> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const project = path.resolve(projectDir) as ProjectPath;
    const dir = path.join(project, "plan-review") as RecordPath;
    const at = (artifact: Artifact): string => path.join(dir, pathOf(artifact));
    const plan = at({ kind: "plan" }) as RecordPath;
    const questions = at({ kind: "questions" }) as RecordPath;
    const requirements = at({ kind: "requirements" }) as RecordPath;
    const decisionsFile = at({ kind: "decisions" });
    const feedbackFile = at({ kind: "feedback" });
    const conversationFile = at({ kind: "conversation" });
    const usageFile = at({ kind: "usage" });

    /** Every file-system call goes through here, so no PlatformError escapes. */
    const io = <A>(operation: string, file: string, effect: Effect.Effect<A, PlatformError.PlatformError>): Effect.Effect<A, FileSystemError> =>
      Effect.mapError(effect, (e) => new FileSystemError({ operation, path: file, message: e.message }));
    const exists = (file: string) => io("read", file, fs.exists(file));
    const readText = (file: string) => io("read", file, fs.readFileString(file));
    const writeText = (file: string, text: string) => io("write", file, fs.writeFileString(file, text));
    const append = (file: string, text: string) => io("append to", file, fs.writeFileString(file, text, { flag: "a" }));
    const mkdir = (d: string) => io("create directory", d, fs.makeDirectory(d, { recursive: true }));
    const list = (d: string) => io("list", d, fs.readDirectory(d));
    /** The current time of the Clock service (finding 22), as an ISO string. */
    const now = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString()));
    /** True when the platform error says the path already exists. */
    const alreadyExists = (e: PlatformError.PlatformError): boolean => e.reason._tag === "AlreadyExists";
    /** JSON text of a value, inside the effect: a value that cannot be serialized is a FileSystemError ("serialize"). */
    const serialize = (file: string, value: unknown, indent?: number): Effect.Effect<string, FileSystemError> =>
      Effect.try({
        try: () => JSON.stringify(value, null, indent),
        catch: (e: unknown) => new FileSystemError({ operation: "serialize", path: file, message: e instanceof Error ? e.message : String(e) }),
      });
    /**
     * Writes one JSON record, creating its directory: the text goes to `<file>.tmp-<pid>` and is renamed into
     * place, so a reader sees the previous record or the new one, never a partial one (finding 16; Q6).
     */
    const writeJson = (file: string, value: unknown) =>
      Effect.gen(function* () {
        const text = yield* serialize(file, value, 2);
        yield* mkdir(path.dirname(file));
        const temporary = `${file}.tmp-${process.pid}`;
        yield* writeText(temporary, text + "\n");
        yield* io("rename", file, fs.rename(temporary, file));
      });
    /** plan-review/checkpoint.json: the last committed transition, replaced atomically. */
    const checkpoint = (point: CheckpointPoint) => now.pipe(Effect.flatMap((time) => writeJson(at({ kind: "checkpoint" }), { version: VERSION, ...point, time })));
    /** One record of the catalog, as JSON. */
    const saveRecord = (artifact: Artifact, value: unknown) => writeJson(at(artifact), value);
    const saveLog = (subject: SubjectId, log: readonly LogEntry[]) => saveRecord({ kind: "log", subject }, { version: VERSION, entries: log });
    const converse = (markdown: string) => append(conversationFile, markdown);

    /**
     * What is at a working-tree path: a link is the link itself (readLink, which also works for a dangling
     * link), a regular file its content hash, a directory or a missing path as such. stat follows links,
     * so readLink is asked first.
     */
    const inspect = (relative: string): Effect.Effect<WorkingTreeEntry, FileSystemError> =>
      Effect.gen(function* () {
        const file = path.join(project, relative);
        const link = yield* fs.readLink(file).pipe(Effect.map(Option.some), Effect.catch(() => Effect.succeed(Option.none<string>())));
        if (Option.isSome(link)) return { type: "link" as const, target: link.value };
        const stat = yield* Effect.exit(fs.stat(file));
        if (Exit.isFailure(stat)) {
          const error = Cause.findErrorOption(stat.cause);
          if (Option.isSome(error) && error.value.reason._tag === "NotFound") return { type: "missing" as const };
          return yield* Effect.fail(new FileSystemError({ operation: "stat", path: file, message: Option.isSome(error) ? error.value.message : String(Cause.squash(stat.cause)) }));
        }
        if (stat.value.type === "Directory") return { type: "directory" as const };
        const bytes = yield* io("read", file, fs.readFile(file));
        return { type: "file" as const, hash: createHash("sha256").update(bytes).digest("hex") };
      });

    /** One git command in the project. A non-zero exit or a spawn failure is a GitError. */
    const git = (args: string[]): Effect.Effect<string, GitError> =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make("git", ["-C", project, ...args]));
          const [out, err] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))], { concurrency: "unbounded" });
          const code = yield* handle.exitCode;
          if (code !== 0) return yield* Effect.fail(new GitError({ args, message: err.trim() !== "" ? err.trim() : `exit code ${code}` }));
          return out;
        }),
      ).pipe(Effect.catchTag("PlatformError", (e) => Effect.fail(new GitError({ args, message: e.message }))));

    return {
      project,
      dir,
      plan,
      questions,
      requirements,

      /** Starts a new run. The files of an earlier run are moved to plan-review/archive-<time>/; config.json stays. */
      init: (task) =>
        Effect.gen(function* () {
          yield* mkdir(dir);
          const earlier = (yield* list(dir)).filter((name) => name !== pathOf({ kind: "config" }) && !name.startsWith("archive-"));
          if (earlier.length > 0) {
            // A second run in the same clock instant gets a collision suffix (finding 23).
            const base = path.join(dir, `archive-${(yield* now).replace(/[:.]/g, "-")}`);
            let archive = base;
            for (let k = 2; yield* exists(archive); k++) archive = `${base}-${k}`;
            yield* io("create directory", archive, fs.makeDirectory(archive));
            for (const name of earlier) yield* io("move", path.join(dir, name), fs.rename(path.join(dir, name), path.join(archive, name)));
          }
          for (const subject of LOG_SUBJECTS) yield* saveLog(subject, []);
          yield* writeText(decisionsFile, "");
          yield* writeText(feedbackFile, "");
          yield* writeText(conversationFile, `# Conversation record\n\nTask: ${task}\n\n`);
          yield* checkpoint({ subject: "run", phase: 0, round: 0, stage: "started" });
        }),
      saveReview: (subject, round, review) => saveRecord({ kind: "review", subject, round }, review),
      saveResponse: (subject, round, response) => saveRecord({ kind: "response", subject, round }, response),
      saveRound: (subject, record) => saveRecord({ kind: "round", subject, round: record.round }, { version: VERSION, ...record }),
      savePlanWrite: (phase, result) => saveRecord({ kind: "planWrite", phase }, result),
      saveExecution: (phase, outcome) => saveRecord({ kind: "execution", phase }, outcome),
      saveQuestions: (task, list) => saveRecord({ kind: "questions" }, questionsFile(task, list)),
      // The readers accept the version-1 files of earlier runs as well (Q5's follow-up).
      loadQuestions: () => readText(questions).pipe(Effect.flatMap((text) => Effect.fromResult(readQuestions(questions, text)))),
      writeRequirements: (text) => writeText(requirements, text),
      planExists: () =>
        Effect.gen(function* () {
          if (!(yield* exists(plan))) return false;
          return (yield* io("read", plan, fs.stat(plan))).size > 0n;
        }),
      loadLog: (subject) => {
        const file = at({ kind: "log", subject });
        return readText(file).pipe(Effect.flatMap((text) => Effect.fromResult(readLog(file, text))));
      },
      saveLog,
      /** One decision event gives both the record line and the transcript line (finding 15). */
      appendDecision: (event) => {
        const lines = renderDecision(event);
        return append(decisionsFile, lines.record).pipe(Effect.andThen(converse(lines.conversation)));
      },
      recordFeedback: (subject, round, text) => append(feedbackFile, renderFeedback(subjectHeading(subject), round, text)),
      converse,
      /**
       * Appends one line to usage.jsonl: the usage an agent reported for one call, as a version-2 record
       * (Q5). The time is read when the effect runs, and it is the store's.
       */
      recordUsage: (line) =>
        Effect.gen(function* () {
          const time = yield* now;
          const record: UsageRecord =
            line.agent === "claude"
              ? { version: VERSION, agent: "claude", time, session: line.session, num_turns: line.turns, total_cost_usd: line.totalCostUsd }
              : { version: VERSION, agent: "codex", time, thread: line.thread, input_tokens: line.inputTokens, output_tokens: line.outputTokens };
          yield* append(usageFile, (yield* serialize(usageFile, record)) + "\n");
        }),
      /** The usage lines of either version in their per-agent shape (src/usage.ts folds them); no file gives none. */
      usageLines: () =>
        Effect.gen(function* () {
          if (!(yield* exists(usageFile))) return [];
          const records = yield* Effect.fromResult(readUsage(usageFile, yield* readText(usageFile)));
          return records.map((r) =>
            r.agent === "claude"
              ? { agent: "claude" as const, session: r.session, turns: r.num_turns, totalCostUsd: r.total_cost_usd }
              : { agent: "codex" as const, thread: r.thread, inputTokens: r.input_tokens, outputTokens: r.output_tokens },
          );
        }),
      fileHash: (subject) =>
        Effect.gen(function* () {
          const file = at(reviewedFile(subject));
          if (!(yield* exists(file))) return "";
          return createHash("sha256").update(yield* io("read", file, fs.readFile(file))).digest("hex");
        }),
      /**
       * Keeps a reply that did not match its schema, as plan-review/invalid-replies/<agent>-<n>.json, and returns
       * that relative path. The file is created exclusively (`wx`) and the number is retried while the name is
       * taken (finding 23): a gap in the sequence never leads to an overwrite.
       */
      saveInvalidReply: (agent, content) =>
        Effect.gen(function* () {
          const d = path.dirname(at({ kind: "invalidReply", agent, n: 1 }));
          yield* mkdir(d);
          let n = (yield* list(d)).filter((name) => name.startsWith(`${agent}-`)).length + 1;
          for (;;) {
            const artifact: Artifact = { kind: "invalidReply", agent, n };
            const file = at(artifact);
            const created = yield* fs.writeFileString(file, content, { flag: "wx" }).pipe(
              Effect.map(() => true),
              Effect.catch((e) => (alreadyExists(e) ? Effect.succeed(false) : Effect.fail(new FileSystemError({ operation: "create", path: file, message: e.message })))),
            );
            if (created) return recordPath(artifact);
            n++;
          }
        }),
      /**
       * The project outside plan-review/ (decision Q1): every path git lists as changed, staged, renamed,
       * unmerged or untracked, with its porcelain v2 record and what is in the working tree at it.
       * Gitignored files are unobserved; the excluded paths (plan-review/, ignorePaths) are dropped.
       */
      checkpoint,
      projectSnapshot: (): Effect.Effect<Snapshot, StoreError> =>
        Effect.gen(function* () {
          const records = decodeStatusV2(yield* git(["status", "--porcelain=v2", "-z", "--untracked-files=all"])).filter((r) => !excluded(r.path, ignorePaths));
          const entries = new Map<string, { record: (typeof records)[number]; content: WorkingTreeEntry }>();
          for (const record of records) entries.set(record.path, { record, content: yield* inspect(record.path) });
          return { entries };
        }),
    };
  });

export const storeLayer = (project: string, ignorePaths: readonly string[]): Layer.Layer<Store, never, Platform> => Layer.effect(Store, makeStore(project, ignorePaths));
