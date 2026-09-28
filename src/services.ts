// The services of the procedure. Every method returns an Effect with its errors in the error channel.
// Tests provide scripted layers; main.ts provides the live ones. API names: docs/effect-v4-api.md.

import { Context, Effect } from "effect";
import type { Brand, Schema } from "effect";
import type { ClaudeCallFailed, CodexCallFailed, FileSystemError, GitError, RunError, StateFileInvalid, UserStopped } from "./errors.ts";
import type { SubjectId } from "./artifacts.ts";
import type { CheckpointPoint, RoundRecord } from "./records.ts";
import type { DecisionEvent } from "./reviewState.ts";
import type { Config, DecisionAnalysis, ExecOutcome, LogEntry, PlannerResponse, PlanWriteResult, QuestionsFile, Review, UserQuestion } from "./schema.ts";
import type { Phase, UiEvent } from "./uiEvents.ts";
import type { UsageLine } from "./usage.ts";
import type { AgentSdk } from "./sdk.ts";
import type { RecordsSnapshot, Snapshot } from "./snapshot.ts";

export type StoreError = FileSystemError | StateFileInvalid | GitError;
/** The question a decision analyzes (decision support): its text and options, and the phase in which it was asked. */
export type DecisionQuestion = Readonly<{ phase: Phase; question: string; options: UserQuestion["options"] }>;
/** The user's answer after an analysis, and the option it chose (null for free text; decision Q4). */
export type Choice = Readonly<{ answer: string; option: string | null }>;
export type PlannerError = ClaudeCallFailed | UserStopped | StoreError;
export type ReviewerError = CodexCallFailed | StoreError;

export interface UiShape {
  readonly say: (text: string) => Effect.Effect<void>;
  /** Reads one line. The answer "q" fails with UserStopped. */
  readonly ask: (prompt: string) => Effect.Effect<string, UserStopped>;
  /** Reads one message of the interview (see TerminalUi). The message "/quit" fails with UserStopped. */
  readonly askMessage: (prompt: string) => Effect.Effect<string, UserStopped>;
  /** A structured event of the run (decision Q5). The terminal prints nothing for it; the records do not depend on it. */
  readonly notify: (event: UiEvent) => Effect.Effect<void>;
}
export class Ui extends Context.Service<Ui, UiShape>()("plan-review/Ui") {}

/** What a planning call is for, as the activity line names it; the interview also prints its tool use in the terminal. */
export type PlanningPurpose = "planning" | "interview";
export type PlanningResult = Readonly<{ output: unknown; resultText: string; costUsd: number | null }>;
/**
 * What a planning call may do (finding 1 of docs/gui-review.md): "records" may edit only under plan-review/ (behaviour 3);
 * "readOnly" may call no tool but the structured output (a work response, behaviour 12), its repair turn included.
 */
export type PlanningCapability = "records" | "readOnly";
export interface PlannerShape {
  /**
   * A call in which Claude Code may write only under plan-review/ ("records", the default), or call no tool but the
   * structured output ("readOnly"). The output is returned as produced; the caller decodes it.
   */
  planning(prompt: string, schema: Schema.Top, purpose?: PlanningPurpose, capability?: PlanningCapability): Effect.Effect<PlanningResult, PlannerError>;
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

/**
 * The records in <project>/plan-review/ and the comparison of the project state: one domain operation per
 * artifact of src/artifacts.ts (finding 27, recommendation D). The path fields are read-only values for messages and tests.
 */
export interface StoreShape {
  readonly project: ProjectPath;
  readonly dir: RecordPath;
  readonly plan: RecordPath;
  readonly questions: RecordPath;
  readonly requirements: RecordPath;
  init(task: string): Effect.Effect<void, StoreError>;
  /** Codex's raw reply of a round (`review-<n>.json`). */
  saveReview(subject: SubjectId, round: number, review: Review): Effect.Effect<void, StoreError>;
  /** Claude Code's raw response of a round (`cc-<n>.json`). */
  saveResponse(subject: SubjectId, round: number, response: PlannerResponse): Effect.Effect<void, StoreError>;
  /** The program's validated record of a round (`round-<n>.json`, version 2). */
  saveRound(subject: SubjectId, record: RoundRecord): Effect.Effect<void, StoreError>;
  /** The output of the call that wrote or revised the plan (`planning-<k>/cc-0.json`). */
  savePlanWrite(phase: number, result: PlanWriteResult): Effect.Effect<void, StoreError>;
  /** The outcome of an execution phase (`execution-<k>/result.json`). */
  saveExecution(phase: number, outcome: ExecOutcome): Effect.Effect<void, StoreError>;
  /** The agreed question list as the program records it (`questions.json`, version 2). */
  saveQuestions(task: string, questions: QuestionsFile["questions"]): Effect.Effect<void, StoreError>;
  loadQuestions(): Effect.Effect<QuestionsFile, StoreError>;
  writeRequirements(text: string): Effect.Effect<void, StoreError>;
  planExists(): Effect.Effect<boolean, StoreError>;
  loadLog(subject: SubjectId): Effect.Effect<readonly LogEntry[], StoreError>;
  saveLog(subject: SubjectId, log: readonly LogEntry[]): Effect.Effect<void, StoreError>;
  /** One decision of the user: the line in user-decisions.md and the transcript line derive from the one event. */
  appendDecision(event: DecisionEvent): Effect.Effect<void, StoreError>;
  recordFeedback(subject: SubjectId, round: number, text: string): Effect.Effect<void, StoreError>;
  converse(markdown: string): Effect.Effect<void, StoreError>;
  recordUsage(line: UsageLine): Effect.Effect<void, StoreError>;
  usageLines(): Effect.Effect<readonly UsageLine[], StoreError>;
  /**
   * The hash of what a subject's rounds observe (behaviour 7): the reviewed file's content; for a work review the
   * diff recomputed from the baseline and the current tree (Q14). "" when it does not exist.
   */
  fileHash(subject: SubjectId): Effect.Effect<string, StoreError>;
  /** The hash of the bytes of the reviewed artifact on disk (the guard of behaviour 5); equal to fileHash but for a work review. */
  recordHash(subject: SubjectId): Effect.Effect<string, StoreError>;
  /** Writes work-review-<phase>/changes.diff: the diff of the project from the baseline tree to the current one (Q7). */
  changeRecord(phase: number): Effect.Effect<void, StoreError>;
  /** The text of work-review-<phase>/changes.diff, for the prompt of a read-only work response ("" when it does not exist). */
  readChangeRecord(phase: number): Effect.Effect<string, StoreError>;
  saveInvalidReply(agent: "claude" | "codex", content: string): Effect.Effect<string, StoreError>;
  projectSnapshot(): Effect.Effect<Snapshot, StoreError>;
  /** The guarded records under plan-review/ (src/artifacts.ts guardedRecord): the second check of a read-only call. */
  recordsSnapshot(): Effect.Effect<RecordsSnapshot, StoreError>;
  /** Allocates the next decision number k by creating decision-<k>/, and writes decision-<k>/question.json. */
  openDecision(question: DecisionQuestion): Effect.Effect<number, StoreError>;
  /** The raw output of decision k's analysis call (`decision-<k>/cc-0.json`). */
  saveAnalysisWrite(decision: number, output: unknown): Effect.Effect<void, StoreError>;
  /** The validated analysis of decision k, its reviewed file (`decision-<k>/analysis.json`). */
  saveAnalysis(decision: number, analysis: DecisionAnalysis): Effect.Effect<void, StoreError>;
  loadAnalysis(decision: number): Effect.Effect<DecisionAnalysis, StoreError>;
  /** The user's choice after decision k (`decision-<k>/chosen.json`, decision Q4). */
  saveChoice(decision: number, choice: Choice): Effect.Effect<void, StoreError>;
  /** The texts of requirements.md and plan.md, null where one does not exist: the context of a decision (decision Q3). */
  readContext(): Effect.Effect<Readonly<{ requirements: string | null; plan: string | null }>, StoreError>;
  /** Replaces plan-review/checkpoint.json atomically with the last committed transition (Q6). */
  checkpoint(point: CheckpointPoint): Effect.Effect<void, StoreError>;
}
export class Store extends Context.Service<Store, StoreShape>()("plan-review/Store") {}

/** The configuration of the run (schema Config). */
export class RunConfig extends Context.Service<RunConfig, Config>()("plan-review/RunConfig") {}

/** The two SDKs (src/sdk.ts): the live binding in main.ts, a fake in the tests. */
export class Sdk extends Context.Service<Sdk, AgentSdk>()("plan-review/Sdk") {}

/** Everything the procedure needs. */
export type Services = Ui | Planner | Reviewer | Store | RunConfig;
