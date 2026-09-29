// The transport retry of issue #26: a call that produced no reply, because of a transport fault, is made again with
// backoff; when the retries are exhausted the user decides.

import { Duration, Effect, Result } from "effect";
import { AgentUnreachable, type RunError, type TransportFault } from "./errors.ts";
import { parseTransportAnswer } from "./input.ts";
import { askOffering, transportOptions } from "./offer.ts";
import * as prompts from "./prompts.ts";
import type { Config } from "./schema.ts";
import { type Decider, RunConfig, Store, Ui } from "./services.ts";

/** The waits before retry 1, 2, …, maxTransportRetries in seconds: the configured delay, doubled on each retry. */
export const retryDelays = (config: Pick<Config, "maxTransportRetries" | "transportRetryDelaySeconds">): readonly number[] =>
  Array.from({ length: config.maxTransportRetries }, (_, k) => config.transportRetryDelaySeconds * 2 ** k);

const isFault = (e: unknown): e is TransportFault => typeof e === "object" && e !== null && (e as { _tag?: unknown })._tag === "TransportFault";

/**
 * Runs `attempt(1)`, and on a TransportFault runs it again with backoff (`retryDelays`): each retry is notified, said and
 * recorded in conversation.md, waits on the Clock (interruptible), and runs `beforeRetry`, the caller's guard, before
 * `attempt(n + 1)`. When the retries are exhausted the user decides, with decision support's offer: another set of
 * retries (the backoff starts again), or a stop, which fails with AgentUnreachable. Any other failure passes through.
 */
export const withTransportRetry = <A, E, R>(
  agent: "claude" | "codex",
  what: string,
  attempt: (n: number) => Effect.Effect<A, E | TransportFault, R>,
  beforeRetry: Effect.Effect<void, RunError, R>,
): Effect.Effect<A, Exclude<E, TransportFault> | AgentUnreachable | RunError, R | Ui | Decider | Store | RunConfig> =>
  Effect.gen(function* () {
    const config = yield* RunConfig;
    const ui = yield* Ui;
    const store = yield* Store;
    const delays = retryDelays(config);
    const say = (text: string) => ui.say(text).pipe(Effect.andThen(store.converse(`${text}\n\n`)));
    let retried = 0;
    for (let n = 1; ; n++) {
      const result = yield* Effect.result(attempt(n));
      if (Result.isSuccess(result)) {
        if (n > 1) yield* ui.notify({ _tag: "TransportRecovered", agent });
        return result.success;
      }
      const error = result.failure;
      if (!isFault(error)) return yield* Effect.fail(error as Exclude<E, TransportFault>);
      const delay = delays[retried];
      if (delay !== undefined) {
        retried++;
        yield* ui.notify({ _tag: "TransportRetrying", agent, attempt: retried, of: delays.length, delaySeconds: delay, fault: error.message });
        yield* say(prompts.transportRetryLine(agent, retried, delays.length, delay, error.message));
        yield* Effect.sleep(Duration.seconds(delay));
      } else {
        const question = prompts.transportExhaustedQuestion(agent, what, n, error.message);
        yield* ui.say(question);
        const answer = yield* askOffering((p) => ui.ask(p), prompts.transportPrompt, { question, options: transportOptions() }, Effect.void, (a) => parseTransportAnswer(a) !== null);
        const choice = parseTransportAnswer(answer) ?? "stop";
        yield* store.converse(prompts.transportDecisionLine(choice, agent, what));
        if (choice === "stop") return yield* Effect.fail(new AgentUnreachable({ agent, attempts: n, lastFault: error.message }));
        retried = 0;
      }
      yield* beforeRetry;
    }
  });
