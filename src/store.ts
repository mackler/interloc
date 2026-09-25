// The Store service on the platform services: the files in <project>/plan-review/ and the
// comparison of the project state (decoded and compared by src/snapshot.ts).
// API names: docs/effect-v4-api.md.

import { Cause, Effect, Exit, FileSystem, Layer, Option, Path, type PlatformError, Result, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { createHash } from "node:crypto";
import { ConfigInvalid, FileSystemError, GitError } from "./errors.ts";
import * as S from "./schema.ts";
import type { Config, LogEntry, UsageRecord } from "./schema.ts";
import { readLog, readQuestions, readUsage, VERSION } from "./records.ts";
import { decodeText } from "./state.ts";
import { type ProjectPath, type RecordPath, Store, type StoreError, type StoreShape } from "./services.ts";
import { decodeStatusV2, excluded, type Snapshot, type WorkingTreeEntry } from "./snapshot.ts";
import { summarizeUsage, type UsageLine, type UsageSummary } from "./usage.ts";

/** The platform services the store needs. */
export type Platform = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

/** The live platform services of Node.js. */
export const platformLayer: Layer.Layer<Platform> = Layer.provideMerge(NodeChildProcessSpawner.layer, Layer.mergeAll(NodeFileSystem.layer, NodePath.layer));

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const decodeConfigFile = Schema.decodeUnknownResult(S.PartialConfig, { onExcessProperty: "error" });

/** The content of one config file. Invalid JSON, a wrong type and an unknown key are ConfigInvalid. */
export const decodeConfigText = (file: string, text: string): Result.Result<Partial<Config>, ConfigInvalid> => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return Result.fail(new ConfigInvalid({ file, path: "", message: message(e) }));
  }
  const decoded = decodeConfigFile(json);
  return Result.isSuccess(decoded) ? Result.succeed(decoded.success) : Result.fail(new ConfigInvalid({ file, ...S.firstIssue(decoded.failure) }));
};

/**
 * The configuration: the defaults, then the shared config file, then <project>/plan-review/config.json
 * (decided behaviour 9). Invalid JSON, a wrong type or an unknown key is ConfigInvalid (Q4).
 */
export const loadConfig = (project: string, sharedFile: string): Effect.Effect<Config, ConfigInvalid | FileSystemError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const io = <A>(file: string, effect: Effect.Effect<A, PlatformError.PlatformError>): Effect.Effect<A, FileSystemError> =>
      Effect.mapError(effect, (e) => new FileSystemError({ operation: "read", path: file, message: e.message }));
    const read = (file: string): Effect.Effect<Partial<Config>, ConfigInvalid | FileSystemError> =>
      Effect.gen(function* () {
        if (!(yield* io(file, fs.exists(file)))) return {};
        const text = yield* io(file, fs.readFileString(file));
        return yield* Effect.fromResult(decodeConfigText(file, text));
      });
    const shared = yield* read(sharedFile);
    const own = yield* read(path.join(path.resolve(project), "plan-review", "config.json"));
    return { ...S.defaultConfig, ...shared, ...own };
  });

const LOG_FILES = ["issue-log.json", "questions-log.json", "requirements-log.json"];

/** The store of one project. `ignorePaths` are the paths the change detection ignores (config). */
export const makeStore = (projectDir: string, ignorePaths: readonly string[]): Effect.Effect<StoreShape, never, Platform> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const project = path.resolve(projectDir) as ProjectPath;
    const dir = path.join(project, "plan-review") as RecordPath;
    const plan = path.join(dir, "plan.md") as RecordPath;
    const questions = path.join(dir, "questions.json") as RecordPath;
    const requirements = path.join(dir, "requirements.md") as RecordPath;
    const decisionsFile = path.join(dir, "user-decisions.md");
    const feedbackFile = path.join(dir, "reviewer-feedback.md");
    const conversationFile = path.join(dir, "conversation.md");
    const usageFile = path.join(dir, "usage.jsonl");

    /** Every file-system call goes through here, so no PlatformError escapes. */
    const io = <A>(operation: string, file: string, effect: Effect.Effect<A, PlatformError.PlatformError>): Effect.Effect<A, FileSystemError> =>
      Effect.mapError(effect, (e) => new FileSystemError({ operation, path: file, message: e.message }));
    const exists = (file: string) => io("read", file, fs.exists(file));
    const readText = (file: string) => io("read", file, fs.readFileString(file));
    const writeText = (file: string, text: string) => io("write", file, fs.writeFileString(file, text));
    const append = (file: string, text: string) => io("append to", file, fs.writeFileString(file, text, { flag: "a" }));
    const mkdir = (d: string) => io("create directory", d, fs.makeDirectory(d, { recursive: true }));
    const list = (d: string) => io("list", d, fs.readDirectory(d));
    /** JSON text of a value, inside the effect: a value that cannot be serialized is a FileSystemError ("serialize"). */
    const serialize = (file: string, value: unknown, indent?: number): Effect.Effect<string, FileSystemError> =>
      Effect.try({
        try: () => JSON.stringify(value, null, indent),
        catch: (e: unknown) => new FileSystemError({ operation: "serialize", path: file, message: e instanceof Error ? e.message : String(e) }),
      });
    const writeJson = (file: string, value: unknown) => serialize(file, value, 2).pipe(Effect.flatMap((text) => writeText(file, text + "\n")));
    /** Reads, parses and decodes a JSON file of the program's own records. */
    const readJson = <Out extends Schema.ConstraintDecoder<unknown>>(file: string, schema: Out): Effect.Effect<Out["Type"], StoreError> =>
      readText(file).pipe(Effect.flatMap((text) => Effect.fromResult(decodeText(file, schema, text))));
    const saveLog = (name: string, log: readonly LogEntry[]) => writeJson(path.join(dir, name), { version: VERSION, entries: log });
    const converse = (markdown: string) => append(conversationFile, markdown);
    const subDir = (name: string) =>
      Effect.gen(function* () {
        const d = path.join(dir, name);
        yield* mkdir(d);
        return d;
      });

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
          const earlier = (yield* list(dir)).filter((name) => name !== "config.json" && !name.startsWith("archive-"));
          if (earlier.length > 0) {
            const archive = path.join(dir, `archive-${new Date().toISOString().replace(/[:.]/g, "-")}`);
            yield* io("create directory", archive, fs.makeDirectory(archive));
            for (const name of earlier) yield* io("move", path.join(dir, name), fs.rename(path.join(dir, name), path.join(archive, name)));
          }
          for (const name of LOG_FILES) yield* saveLog(name, []);
          yield* writeText(decisionsFile, "");
          yield* writeText(feedbackFile, "");
          yield* writeText(conversationFile, `# Conversation record\n\nTask: ${task}\n\n`);
        }),
      subDir,
      writeJson,
      writeText,
      // The readers accept the version-1 files of earlier runs as well (Q5's follow-up).
      loadLog: (name = "issue-log.json") => {
        const file = path.join(dir, name);
        return readText(file).pipe(Effect.flatMap((text) => Effect.fromResult(readLog(file, text))));
      },
      saveLog,
      loadQuestions: () => readText(questions).pipe(Effect.flatMap((text) => Effect.fromResult(readQuestions(questions, text)))),
      recordDecision: (subject, decision) =>
        append(decisionsFile, `Subject: ${subject}\nDecision: ${decision}\n\n`).pipe(Effect.andThen(converse(`**User decision** on ${subject}: ${decision}\n\n`))),
      recordFeedback: (heading, round, text) => append(feedbackFile, `## ${heading}, round ${round}\n${text}\n\n`),
      /**
       * Appends one line to usage.jsonl: the usage an agent reported for one call, as a version-2 record
       * (Q5). The time is read when the effect runs, and it is the store's.
       */
      recordUsage: (line) =>
        Effect.suspend(() => {
          const time = new Date().toISOString();
          const record: UsageRecord =
            line.agent === "claude"
              ? { version: VERSION, agent: "claude", time, session: line.session, num_turns: line.turns, total_cost_usd: line.totalCostUsd }
              : { version: VERSION, agent: "codex", time, thread: line.thread, input_tokens: line.inputTokens, output_tokens: line.outputTokens };
          return serialize(usageFile, record);
        }).pipe(Effect.flatMap((text) => append(usageFile, text + "\n"))),
      /** The usage lines of either version, read into their per-agent shape and folded by src/usage.ts; no file gives the empty summary. */
      usageSummary: (): Effect.Effect<UsageSummary, StoreError> =>
        Effect.gen(function* () {
          if (!(yield* exists(usageFile))) return summarizeUsage([]);
          const records = yield* Effect.fromResult(readUsage(usageFile, yield* readText(usageFile)));
          const lines: UsageLine[] = records.map((r) =>
            r.agent === "claude"
              ? { agent: "claude", session: r.session, turns: r.num_turns, totalCostUsd: r.total_cost_usd }
              : { agent: "codex", thread: r.thread, inputTokens: r.input_tokens, outputTokens: r.output_tokens },
          );
          return summarizeUsage(lines);
        }),
      converse,
      planExists: () =>
        Effect.gen(function* () {
          if (!(yield* exists(plan))) return false;
          return (yield* io("read", plan, fs.stat(plan))).size > 0n;
        }),
      fileHash: (file) =>
        Effect.gen(function* () {
          if (!(yield* exists(file))) return "";
          return createHash("sha256").update(yield* io("read", file, fs.readFile(file))).digest("hex");
        }),
      /** Keeps a reply that did not match its schema, as plan-review/invalid-replies/<agent>-<n>.json. Returns that relative path. */
      saveInvalidReply: (agent, content) =>
        Effect.gen(function* () {
          const d = yield* subDir("invalid-replies");
          const n = (yield* list(d)).filter((name) => name.startsWith(`${agent}-`)).length + 1;
          const name = `${agent}-${n}.json`;
          yield* writeText(path.join(d, name), content);
          return path.join("plan-review", "invalid-replies", name);
        }),
      /**
       * The project outside plan-review/ (decision Q1): every path git lists as changed, staged, renamed,
       * unmerged or untracked, with its porcelain v2 record and what is in the working tree at it.
       * Gitignored files are unobserved; the excluded paths (plan-review/, ignorePaths) are dropped.
       */
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
