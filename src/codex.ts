// Codex through the Codex SDK, as the Reviewer service. One thread per review loop.

import { Effect, Layer, Ref } from "effect";
import { CodexCallFailed } from "./errors.ts";
import { agentJsonSchema } from "./jsonSchema.ts";
import * as S from "./schema.ts";
import type { SdkThread } from "./sdk.ts";
import { Reviewer, type ReviewerShape, RunConfig, Sdk, Store } from "./services.ts";

/** The Reviewer service over the SDK, Store and RunConfig services. */
export const makeCodexReviewer: Effect.Effect<ReviewerShape, never, Sdk | Store | RunConfig> = Effect.gen(function* () {
  const sdk = yield* Sdk;
  const store = yield* Store;
  const config = yield* RunConfig;
  const thread = yield* Ref.make<SdkThread | null>(null);

  return {
    // Bubblewrap cannot start in the container, so Codex's own sandbox is off. The container and its
    // firewall are the boundary, and the caller compares the project state after every turn.
    // Starting a thread can throw synchronously (for example when the SDK cannot start its CLI); that is
    // a typed failure, like a failed turn, not a defect (finding 11 of docs/functional-design-review.md).
    newPhase: Effect.try({
      try: () =>
        sdk.startThread({
          workingDirectory: store.project,
          sandboxMode: "danger-full-access",
          approvalPolicy: "never",
          ...(config.codexModel !== null ? { model: config.codexModel } : {}),
        }),
      catch: (e: unknown) => new CodexCallFailed({ message: e instanceof Error ? e.message : String(e) }),
    }).pipe(Effect.flatMap((started) => Ref.set(thread, started))),

    review: (prompt) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(thread);
        if (current === null) return yield* Effect.fail(new CodexCallFailed({ message: "no review thread: newPhase() was not called" }));
        // The signal of tryPromise is aborted when the fiber is interrupted; the SDK cancels the turn.
        const turn = yield* Effect.tryPromise({
          try: (signal) => current.run(prompt, { outputSchema: agentJsonSchema(S.Review), signal }),
          catch: (e: unknown) => new CodexCallFailed({ message: e instanceof Error ? e.message : String(e) }),
        });
        yield* store.recordUsage({ agent: "codex", thread_id: current.id, usage: turn.usage });
        return turn.finalResponse;
      }),
  };
});

export const codexReviewerLayer: Layer.Layer<Reviewer, never, Sdk | Store | RunConfig> = Layer.effect(Reviewer, makeCodexReviewer);
