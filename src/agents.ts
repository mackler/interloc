// The two agents as the orchestrator sees them. Tests supply scripted implementations.

import type { Schema } from "effect";
import type { ExecOutcome } from "./schema.ts";

export interface Planner {
  /**
   * A call in which Claude Code may write only files under plan-review/. `schema` is the Effect
   * schema of the structured output, which the agent receives as JSON Schema. The output is returned
   * as the agent produced it (absent as null or undefined); the caller decodes it (review.ts).
   */
  planning(prompt: string, schema: Schema.Top, progress?: boolean): Promise<{ output: unknown; resultText: string; costUsd: number | null }>;
  /** A call in which Claude Code implements the plan. */
  executing(prompt: string): Promise<ExecOutcome>;
  sessionId(): string | null;
}

export interface Reviewer {
  /** Starts a new thread. Called at the start of every planning phase. */
  newPhase(): void;
  /** One review turn. Returns the reply text as Codex produced it; the caller decodes it (review.ts). */
  review(prompt: string): Promise<string>;
}
