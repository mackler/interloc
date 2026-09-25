// The services of the procedure. Every method returns an Effect with its errors in the error channel.
// Tests provide scripted layers; main.ts provides the live ones. API names: docs/effect-v4-api.md.

import { Context, Effect } from "effect";
import type { Brand, Schema } from "effect";
import type { ClaudeCallFailed, CodexCallFailed, FileSystemError, GitError, RunError, StateFileInvalid, UserStopped } from "./errors.ts";
import type { Config, ExecOutcome, LogEntry, QuestionsFile } from "./schema.ts";
import type { UsageLine, UsageSummary } from "./usage.ts";
import type { AgentSdk } from "./sdk.ts";
import type { Snapshot } from "./snapshot.ts";

export type StoreError = FileSystemError | StateFileInvalid | GitError;
export type PlannerError = ClaudeCallFailed | UserStopped | StoreError;
export type ReviewerError = CodexCallFailed | StoreError;

export interface UiShape {
  readonly say: (text: string) => Effect.Effect<void>;
  /** Reads one line. The answer "q" fails with UserStopped. */
  readonly ask: (prompt: string) => Effect.Effect<string, UserStopped>;
  /** Reads one message of the interview (see TerminalUi). The message "/quit" fails with UserStopped. */
  readonly askMessage: (prompt: string) => Effect.Effect<string, UserStopped>;
}
export class Ui extends Context.Service<Ui, UiShape>()("plan-review/Ui") {}

export type PlanningResult = Readonly<{ output: unknown; resultText: string; costUsd: number | null }>;
export interface PlannerShape {
  /** A call in which Claude Code may write only under plan-review/. The output is returned as produced; the caller decodes it. */
  planning(prompt: string, schema: Schema.Top, progress?: boolean): Effect.Effect<PlanningResult, PlannerError>;
  /** A call in which Claude Code implements the plan. */
  executing(prompt: string): Effect.Effect<ExecOutcome, PlannerError>;
  readonly sessionId: Effect.Effect<string | null>;
}
export class Planner extends Context.Service<Planner, PlannerShape>()("plan-review/Planner") {}

/** One review loop's thread (behaviour 5). Every call goes to the thread the session was started with. */
export interface ReviewSession {
  /** One review turn. Returns the reply text as Codex produced it; the caller decodes it. */
  review(prompt: string): Effect.Effect<string, ReviewerError>;
}
export interface ReviewerShape {
  /** Starts a new thread and returns the session bound to it. Called at the start of every review loop. A start failure is a typed error (finding 11). */
  readonly startPhase: Effect.Effect<ReviewSession, CodexCallFailed>;
}
export class Reviewer extends Context.Service<Reviewer, ReviewerShape>()("plan-review/Reviewer") {}

/** An absolute path inside the project (finding 21): the root the change detection watches. */
export type ProjectPath = Brand.Branded<string, "ProjectPath">;
/** An absolute path under <project>/plan-review/: where the program and the planning calls may write. */
export type RecordPath = Brand.Branded<string, "RecordPath">;

/** The files in <project>/plan-review/ and the comparison of the project state (today's State). */
export interface StoreShape {
  readonly project: ProjectPath;
  readonly dir: RecordPath;
  readonly plan: RecordPath;
  readonly questions: RecordPath;
  readonly requirements: RecordPath;
  init(task: string): Effect.Effect<void, StoreError>;
  subDir(name: string): Effect.Effect<string, StoreError>;
  writeJson(file: string, value: unknown): Effect.Effect<void, StoreError>;
  writeText(file: string, text: string): Effect.Effect<void, StoreError>;
  loadLog(name?: string): Effect.Effect<readonly LogEntry[], StoreError>;
  saveLog(name: string, log: readonly LogEntry[]): Effect.Effect<void, StoreError>;
  loadQuestions(): Effect.Effect<QuestionsFile, StoreError>;
  recordDecision(subject: string, decision: string): Effect.Effect<void, StoreError>;
  recordFeedback(heading: string, round: number, text: string): Effect.Effect<void, StoreError>;
  recordUsage(line: UsageLine): Effect.Effect<void, StoreError>;
  usageSummary(): Effect.Effect<UsageSummary, StoreError>;
  converse(markdown: string): Effect.Effect<void, StoreError>;
  planExists(): Effect.Effect<boolean, StoreError>;
  fileHash(file: string): Effect.Effect<string, StoreError>;
  saveInvalidReply(agent: "claude" | "codex", content: string): Effect.Effect<string, StoreError>;
  projectSnapshot(): Effect.Effect<Snapshot, StoreError>;
}
export class Store extends Context.Service<Store, StoreShape>()("plan-review/Store") {}

/** The configuration of the run (schema Config). */
export class RunConfig extends Context.Service<RunConfig, Config>()("plan-review/RunConfig") {}

/** The two SDKs (src/sdk.ts): the live binding in main.ts, a fake in the tests. */
export class Sdk extends Context.Service<Sdk, AgentSdk>()("plan-review/Sdk") {}

/** Everything the procedure needs. */
export type Services = Ui | Planner | Reviewer | Store | RunConfig;
