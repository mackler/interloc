// The two agents as the orchestrator sees them. Tests supply scripted implementations.

import { Effect, Layer } from "effect";
import type { Schema } from "effect";
import type { ExecOutcome } from "./schema.ts";
import { liftPromise, Planner as PlannerService, type PlannerError, type PlanningResult, Reviewer as ReviewerService, type ReviewerError } from "./services.ts";

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

/** The Planner service over a Promise adapter (transitional, plan stage 5.1). */
export const plannerLayer = (planner: Planner): Layer.Layer<PlannerService> =>
  Layer.succeed(PlannerService, {
    planning: (prompt, schema, progress) => liftPromise<PlanningResult, PlannerError>(() => planner.planning(prompt, schema, progress)),
    executing: (prompt) => liftPromise<ExecOutcome, PlannerError>(() => planner.executing(prompt)),
    sessionId: Effect.sync(() => planner.sessionId()),
  });

/** The Reviewer service over a Promise adapter (transitional, plan stage 5.1). */
export const reviewerLayer = (reviewer: Reviewer): Layer.Layer<ReviewerService> =>
  Layer.succeed(ReviewerService, {
    newPhase: Effect.sync(() => reviewer.newPhase()),
    review: (prompt) => liftPromise<string, ReviewerError>(() => reviewer.review(prompt)),
  });
