// The two agents as the orchestrator sees them. Tests supply scripted implementations.

import type { ExecOutcome, Review } from "./types.ts";

export interface Planner {
  /** A call in which Claude Code may write only files under plan-review/. Returns the structured output. */
  planning<T>(prompt: string, schema: object, progress?: boolean): Promise<{ output: T; resultText: string; costUsd: number | null }>;
  /** A call in which Claude Code implements the plan. */
  executing(prompt: string): Promise<ExecOutcome>;
  sessionId(): string | null;
}

export interface Reviewer {
  /** Starts a new thread. Called at the start of every planning phase. */
  newPhase(): void;
  review(prompt: string): Promise<Review>;
}
