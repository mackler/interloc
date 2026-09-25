// The Store service on the platform services: the files in <project>/plan-review/ and the
// comparison of the project state. describeChange stays a pure function in state.ts.
// API names: docs/effect-v4-api.md.

import { Effect, FileSystem, Layer, Path, type PlatformError, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { createHash } from "node:crypto";
import { ConfigInvalid, FileSystemError, GitError, type StateFileInvalid } from "./errors.ts";
import * as S from "./schema.ts";
import type { Config, LogEntry } from "./schema.ts";
import { lift, Store, type StoreError, type StoreShape } from "./services.ts";
import { decodeRecord, parseJson, type Snapshot } from "./state.ts";

/** The platform services the store needs. */
export type Platform = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

/** The live platform services of Node.js. */
export const platformLayer: Layer.Layer<Platform> = Layer.provideMerge(NodeChildProcessSpawner.layer, Layer.mergeAll(NodeFileSystem.layer, NodePath.layer));

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const decodeConfigFile = Schema.decodeUnknownSync(S.PartialConfig, { onExcessProperty: "error" });

/** The content of one config file. Invalid JSON, a wrong type and an unknown key are ConfigInvalid. */
const decodeConfigText = (file: string, text: string): Partial<Config> => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new ConfigInvalid({ file, path: "", message: message(e) });
  }
  try {
    return decodeConfigFile(json);
  } catch (e) {
    if (Schema.isSchemaError(e)) throw new ConfigInvalid({ file, ...S.firstIssue(e) });
    throw e;
  }
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
        return yield* lift<Partial<Config>, ConfigInvalid>(() => decodeConfigText(file, text));
      });
    const shared = yield* read(sharedFile);
    const own = yield* read(path.join(path.resolve(project), "plan-review", "config.json"));
    return { ...S.defaultConfig, ...shared, ...own };
  });

const LogFile = Schema.Array(S.LogEntry);
const LOG_FILES = ["issue-log.json", "questions-log.json", "requirements-log.json"];

/** The store of one project. `ignorePaths` are the paths the change detection ignores (config). */
export const makeStore = (projectDir: string, ignorePaths: readonly string[]): Effect.Effect<StoreShape, never, Platform> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const project = path.resolve(projectDir);
    const dir = path.join(project, "plan-review");
    const plan = path.join(dir, "plan.md");
    const questions = path.join(dir, "questions.json");
    const requirements = path.join(dir, "requirements.md");
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
    const writeJson = (file: string, value: unknown) => writeText(file, JSON.stringify(value, null, 2) + "\n");
    /** Reads, parses and decodes a JSON file of the program's own records. */
    const readJson = <Out extends Schema.ConstraintDecoder<unknown>>(file: string, schema: Out): Effect.Effect<Out["Type"], StoreError> =>
      readText(file).pipe(Effect.flatMap((text) => lift<Out["Type"], StateFileInvalid>(() => decodeRecord(file, schema, parseJson(file, text)))));
    const saveLog = (name: string, log: LogEntry[]) => writeJson(path.join(dir, name), log);
    const converse = (markdown: string) => append(conversationFile, markdown);
    const subDir = (name: string) =>
      Effect.gen(function* () {
        const d = path.join(dir, name);
        yield* mkdir(d);
        return d;
      });

    const ignored = (file: string): boolean => ignorePaths.some((p) => file === p || file.startsWith(p.endsWith("/") ? p : `${p}/`));

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
      loadLog: (name = "issue-log.json") => readJson(path.join(dir, name), LogFile).pipe(Effect.map((log) => [...log])),
      saveLog,
      loadQuestions: () => readJson(questions, S.QuestionsFile),
      recordDecision: (subject, decision) =>
        append(decisionsFile, `Subject: ${subject}\nDecision: ${decision}\n\n`).pipe(Effect.andThen(converse(`**User decision** on ${subject}: ${decision}\n\n`))),
      recordFeedback: (heading, round, text) => append(feedbackFile, `## ${heading}, round ${round}\n${text}\n\n`),
      /** Appends one line to usage.jsonl: the usage that an agent reported for one call. */
      recordUsage: (entry) => append(usageFile, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n"),
      /** Number of calls and sum of the reported values per agent. */
      usageSummary: () =>
        Effect.gen(function* () {
          if (!(yield* exists(usageFile))) return "no usage recorded";
          const lines = (yield* readText(usageFile)).split("\n").filter((l) => l !== "");
          // Excess properties are ignored: the SDKs decide which usage fields they report.
          const entries = yield* lift<(typeof S.UsageEntry.Type)[], StateFileInvalid>(() =>
            lines.map((line) => decodeRecord(usageFile, S.UsageEntry, parseJson(usageFile, line), { onExcessProperty: "ignore" })),
          );
          const claude = entries.filter((e) => e.agent === "claude");
          const codex = entries.filter((e) => e.agent === "codex");
          const cost = claude.reduce((sum, e) => sum + (typeof e.total_cost_usd === "number" ? e.total_cost_usd : 0), 0);
          const input = codex.reduce((sum, e) => sum + (e.usage?.input_tokens ?? 0), 0);
          const output = codex.reduce((sum, e) => sum + (e.usage?.output_tokens ?? 0), 0);
          return `Claude Code: ${claude.length} calls, sum of reported total_cost_usd = ${cost.toFixed(2)} (an estimate by the client). Codex: ${codex.length} turns, ${input} input tokens, ${output} output tokens. Details: plan-review/usage.jsonl`;
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
       * The project outside plan-review/: the changed and untracked paths, and a hash of the diff of each
       * modified tracked file. A change to the content of an untracked file is not detected.
       */
      projectSnapshot: (): Effect.Effect<Snapshot, StoreError> =>
        Effect.gen(function* () {
          const status = (yield* git(["status", "--porcelain"]))
            .split("\n")
            .filter((line) => line !== "" && !/^.. "?plan-review\//.test(line))
            .filter((line) => !ignored(line.slice(3).replace(/^"|"$/g, "")));
          const diffs = new Map<string, string>();
          const names = (yield* git(["diff", "--name-only"])).split("\n").filter((n) => n !== "" && !ignored(n));
          for (const name of names) diffs.set(name, createHash("sha256").update(yield* git(["diff", "--", name])).digest("hex"));
          return { status, diffs };
        }),
    };
  });

export const storeLayer = (project: string, ignorePaths: readonly string[]): Layer.Layer<Store, never, Platform> => Layer.effect(Store, makeStore(project, ignorePaths));
