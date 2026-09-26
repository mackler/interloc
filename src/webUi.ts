// The Ui of a run in the web page (plan step 3.2): every call becomes a RunEvent for the page, and a prompt waits
// for the first answer any tab sends for it. The answers are interpreted as in the terminal (src/input.ts).

import { Deferred, Effect, Ref, Semaphore } from "effect";
import { UserStopped } from "./errors.ts";
import { parseAskLine, parseMessage } from "./input.ts";
import type { Asked, RunEvent } from "./protocol.ts";
import type { UiShape } from "./services.ts";
import { promptOf } from "./userPrompts.ts";

/** The web Ui of one run: the Ui, and the entry points of the answers from the page. */
export type WebUi = UiShape &
  Readonly<{
    /** The answer to a pending prompt; false when no prompt with that number waits (answered, interrupted, or never asked). */
    answer: (prompt: number, text: string) => Effect.Effect<boolean>;
    /** The prompt that waits, if any. */
    pending: Effect.Effect<Asked | null>;
  }>;

type Waiting = Readonly<{ asked: Asked; answer: Deferred.Deferred<string> }>;
type Prompts = Readonly<{ next: number; waiting: Waiting | null }>;

export const makeWebUi = (sink: (event: RunEvent) => Effect.Effect<void>): Effect.Effect<WebUi> =>
  Effect.gen(function* () {
    // The dialogue is serialized as in the terminal: a second concurrent prompt waits for the first answer.
    const dialogue = yield* Semaphore.make(1);
    const prompts = yield* Ref.make<Prompts>({ next: 1, waiting: null });

    /** Shows the prompt and waits for its first answer; an interruption withdraws the prompt. */
    const waitFor = (text: string): Effect.Effect<string> =>
      Effect.gen(function* () {
        const answer = yield* Deferred.make<string>();
        const asked = yield* Ref.modify(prompts, (p): readonly [Asked, Prompts] => {
          const shown: Asked = { _tag: "Asked", prompt: p.next, ...promptOf(text) };
          return [shown, { next: p.next + 1, waiting: { asked: shown, answer } }];
        });
        yield* sink(asked);
        return yield* Deferred.await(answer).pipe(
          Effect.onInterrupt(() => Ref.update(prompts, (p) => (p.waiting?.asked.prompt === asked.prompt ? { ...p, waiting: null } : p))),
        );
      }).pipe(dialogue.withPermits(1));

    const ask = (text: string): Effect.Effect<string, UserStopped> =>
      waitFor(text).pipe(Effect.flatMap((line) => {
        const parsed = parseAskLine(line);
        return parsed.kind === "quit" ? Effect.fail(new UserStopped({ where: text })) : Effect.succeed(parsed.text);
      }));
    const askMessage = (text: string): Effect.Effect<string, UserStopped> =>
      waitFor(text).pipe(Effect.flatMap((message) => {
        const parsed = parseMessage(message);
        return parsed.kind === "quit" ? Effect.fail(new UserStopped({ where: text })) : Effect.succeed(parsed.text);
      }));

    return {
      say: (text) => sink({ _tag: "Said", text }),
      notify: (event) => sink({ _tag: "Notified", event }),
      ask,
      askMessage,
      answer: (prompt, text) =>
        Effect.gen(function* () {
          const taken = yield* Ref.modify(prompts, (p): readonly [Waiting | null, Prompts] =>
            p.waiting !== null && p.waiting.asked.prompt === prompt ? [p.waiting, { ...p, waiting: null }] : [null, p],
          );
          if (taken === null) return false;
          yield* sink({ _tag: "Answered", prompt, text });
          return yield* Deferred.succeed(taken.answer, text);
        }),
      pending: Ref.get(prompts).pipe(Effect.map((p) => p.waiting?.asked ?? null)),
    };
  });
