// The confirmation before an answer ends the run (S24, issue #25): the one read loop the terminal and the scripted Ui
// share. The page confirms with its own dialog (S25) over the same predicate, endingOf in src/input.ts.

import { Effect } from "effect";
import { endingOf, parseConfirmEnd } from "./input.ts";
import { confirmEndPrompt } from "./prompts.ts";
import { promptOf } from "./userPrompts.ts";

/**
 * Reads the answer to `prompt` with `read`; an answer that ends the run (endingOf) is returned only after `readLine`
 * reads y to its confirmation. Anything else returns to the question, whose prompt is shown again. Ctrl+C does not
 * pass through here and asks nothing (behaviour 11).
 */
export const confirmingRead = <E, R>(
  read: (prompt: string) => Effect.Effect<string, E, R>,
  readLine: (prompt: string) => Effect.Effect<string, E, R>,
  prompt: string,
  mode: "ask" | "message",
): Effect.Effect<string, E, R> =>
  Effect.gen(function* () {
    for (;;) {
      const text = yield* read(prompt);
      const ending = endingOf(promptOf(prompt).kind, mode, text);
      if (ending === null) return text;
      if (parseConfirmEnd(yield* readLine(confirmEndPrompt(ending)))) return text;
    }
  });
