// Codex through the Codex SDK, as the Reviewer service. One thread per review loop.

import { Effect, Layer } from "effect";
import { CodexCallFailed } from "./errors.ts";
import { agentJsonSchema } from "./jsonSchema.ts";
import * as S from "./schema.ts";
import type { SdkThread } from "./sdk.ts";
import { Reviewer, type ReviewerShape, type ReviewSession, RunConfig, Sdk, Store, type StoreShape } from "./services.ts";

/** The session over one thread: the thread is a closed-over value, so a call before the start is impossible. */
const session = (store: StoreShape, thread: SdkThread): ReviewSession => ({
  review: (prompt) =>
    Effect.gen(function* () {
      // The signal of tryPromise is aborted when the fiber is interrupted; the SDK cancels the turn.
      const turn = yield* Effect.tryPromise({
        try: (signal) => thread.run(prompt, { outputSchema: agentJsonSchema(S.Review), signal }),
        catch: (e: unknown) => new CodexCallFailed({ message: e instanceof Error ? e.message : String(e) }),
      });
      const usage = turn.usage as { input_tokens?: number; output_tokens?: number } | null | undefined;
      yield* store.recordUsage({ agent: "codex", thread: thread.id, inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0 });
      return turn.finalResponse;
    }),
});

/** The Reviewer service over the SDK, Store and RunConfig services. */
export const makeCodexReviewer: Effect.Effect<ReviewerShape, never, Sdk | Store | RunConfig> = Effect.gen(function* () {
  const sdk = yield* Sdk;
  const store = yield* Store;
  const config = yield* RunConfig;

  return {
    // Bubblewrap cannot start in the container, so Codex's own sandbox is off. The container and its
    // firewall are the boundary, and the caller compares the project state after every turn.
    // Starting a thread can throw synchronously (for example when the SDK cannot start its CLI); that is
    // a typed failure, like a failed turn, not a defect (finding 11 of docs/functional-design-review.md).
    startPhase: Effect.try({
      try: () =>
        sdk.startThread({
          workingDirectory: store.project,
          sandboxMode: "danger-full-access",
          approvalPolicy: "never",
          ...(config.codexModel !== null ? { model: config.codexModel } : {}),
        }),
      catch: (e: unknown) => new CodexCallFailed({ message: e instanceof Error ? e.message : String(e) }),
    }).pipe(Effect.map((thread) => session(store, thread))),
  };
});

export const codexReviewerLayer: Layer.Layer<Reviewer, never, Sdk | Store | RunConfig> = Layer.effect(Reviewer, makeCodexReviewer);
