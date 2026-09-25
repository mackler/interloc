// The services of the procedure. Every method returns an Effect with its errors in the error channel.
// Tests provide scripted layers; main.ts provides the live ones. API names: docs/effect-v4-api.md.

import { Context, Effect } from "effect";
import type { Schema } from "effect";
import type { ClaudeCallFailed, CodexCallFailed, FileSystemError, GitError, RunError, StateFileInvalid, UserStopped } from "./errors.ts";
import { isRunError } from "./errors.ts";
import type { Config, ExecOutcome, LogEntry, QuestionsFile } from "./schema.ts";
import type { AgentSdk } from "./sdk.ts";
import type { Snapshot } from "./snapshot.ts";

export type StoreError = FileSystemError | StateFileInvalid | GitError;
export type PlannerError = ClaudeCallFailed | UserStopped | StoreError;
export type ReviewerError = CodexCallFailed | StoreError;

export interface UiShape {
  say(text: string): Effect.Effect<void>;
  /** Reads one line. The answer "q" fails with UserStopped. */
  ask(prompt: string): Effect.Effect<string, UserStopped>;
  /** Reads one message of the interview (see TerminalUi). The message "/quit" fails with UserStopped. */
  askMessage(prompt: string): Effect.Effect<string, UserStopped>;
}
export class Ui extends Context.Service<Ui, UiShape>()("plan-review/Ui") {}

export type PlanningResult = { output: unknown; resultText: string; costUsd: number | null };
export interface PlannerShape {
  /** A call in which Claude Code may write only under plan-review/. The output is returned as produced; the caller decodes it. */
  planning(prompt: string, schema: Schema.Top, progress?: boolean): Effect.Effect<PlanningResult, PlannerError>;
  /** A call in which Claude Code implements the plan. */
  executing(prompt: string): Effect.Effect<ExecOutcome, PlannerError>;
  readonly sessionId: Effect.Effect<string | null>;
}
export class Planner extends Context.Service<Planner, PlannerShape>()("plan-review/Planner") {}

export interface ReviewerShape {
  /** Starts a new thread. Called at the start of every review loop. A start failure is a typed error. */
  readonly newPhase: Effect.Effect<void, ReviewerError>;
  /** One review turn. Returns the reply text as Codex produced it; the caller decodes it. */
  review(prompt: string): Effect.Effect<string, ReviewerError>;
}
export class Reviewer extends Context.Service<Reviewer, ReviewerShape>()("plan-review/Reviewer") {}

/** The files in <project>/plan-review/ and the comparison of the project state (today's State). */
export interface StoreShape {
  readonly project: string;
  readonly dir: string;
  readonly plan: string;
  readonly questions: string;
  readonly requirements: string;
  init(task: string): Effect.Effect<void, StoreError>;
  subDir(name: string): Effect.Effect<string, StoreError>;
  writeJson(file: string, value: unknown): Effect.Effect<void, StoreError>;
  writeText(file: string, text: string): Effect.Effect<void, StoreError>;
  loadLog(name?: string): Effect.Effect<LogEntry[], StoreError>;
  saveLog(name: string, log: readonly LogEntry[]): Effect.Effect<void, StoreError>;
  loadQuestions(): Effect.Effect<QuestionsFile, StoreError>;
  recordDecision(subject: string, decision: string): Effect.Effect<void, StoreError>;
  recordFeedback(heading: string, round: number, text: string): Effect.Effect<void, StoreError>;
  recordUsage(entry: Record<string, unknown>): Effect.Effect<void, StoreError>;
  usageSummary(): Effect.Effect<string, StoreError>;
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

/**
 * Lifts a function that throws one of the program's typed errors into an Effect. `E` names the errors
 * the wrapped code can throw; a throw of anything else is a defect. Used where a synchronous decoder
 * that throws the program's errors is called from an Effect (src/store.ts).
 */
export const lift = <A, E extends RunError>(f: () => A): Effect.Effect<A, E> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(f());
    } catch (e) {
      return isRunError(e) ? Effect.fail(e as E) : Effect.die(e);
    }
  });
