// Terminal input and output: the Ui service as a scoped resource on a pair of streams.
// ask reads one line; the answer "q" ends the run. askMessage reads one message of the interview:
// a single line is sent with Enter, and for several lines the user types """ on a line by itself,
// then the text, then """ again; the message "/quit" ends the run.

import { Effect, Layer, type Scope } from "effect";
import * as readline from "node:readline";
import { UserStopped } from "./errors.ts";
import { emptyFold, foldLine, parseAskLine, parseMessage } from "./input.ts";
import { Ui as UiService, type UiShape } from "./services.ts";

/**
 * The terminal Ui as a scoped resource: one readline interface on the given streams for the whole
 * run, closed when the scope closes (the end of the run or an interruption). Lines arrive as events,
 * several at once when text is pasted, and are queued until a call asks for the next one, so no
 * pasted line is lost between two calls. The end of the input ends a waiting call with UserStopped.
 */
export const terminalUi = (
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  // In terminal mode readline receives Ctrl+C itself; the default passes it on as a real SIGINT.
  onInterrupt: () => void = () => process.kill(process.pid, "SIGINT"),
): Effect.Effect<UiShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const rl = yield* Effect.acquireRelease(
      Effect.sync(() => readline.createInterface({ input, output })),
      (rl) => Effect.sync(() => rl.close()),
    );
    rl.on("SIGINT", onInterrupt);
    const lines: string[] = [];
    let waiting: ((line: string | null) => void) | null = null;
    let ended = false;
    const wake = (line: string | null): void => {
      const w = waiting;
      waiting = null;
      w?.(line);
    };
    rl.on("line", (line) => (waiting !== null ? wake(line) : lines.push(line)));
    rl.on("close", () => {
      ended = true;
      wake(null);
    });

    /** The next line of the input; UserStopped at the end of the input. Interruption stops the wait. */
    const nextLine = (prompt: string): Effect.Effect<string, UserStopped> =>
      Effect.callback((resume) => {
        const stopped = Effect.fail(new UserStopped({ where: prompt }));
        const queued = lines.shift();
        if (queued !== undefined) return resume(Effect.succeed(queued));
        if (ended) return resume(stopped);
        waiting = (line) => resume(line === null ? stopped : Effect.succeed(line));
        return Effect.sync(() => {
          waiting = null;
        });
      });
    const showPrompt = (prompt: string): Effect.Effect<void> =>
      Effect.sync(() => {
        rl.setPrompt(prompt);
        rl.prompt();
      });

    return {
      say: (text) => Effect.sync(() => void output.write(text + "\n")),
      ask: (prompt) =>
        Effect.gen(function* () {
          yield* showPrompt(prompt);
          const parsed = parseAskLine(yield* nextLine(prompt));
          if (parsed.kind === "quit") return yield* Effect.fail(new UserStopped({ where: prompt }));
          return parsed.text;
        }),
      askMessage: (prompt) =>
        Effect.gen(function* () {
          yield* showPrompt(prompt);
          let fold = emptyFold;
          while (!fold.complete) fold = foldLine(fold, yield* nextLine(prompt));
          const parsed = parseMessage(fold.lines.join("\n"));
          if (parsed.kind === "quit") return yield* Effect.fail(new UserStopped({ where: prompt }));
          return parsed.text;
        }),
    };
  });

/** The Ui service on the process streams. */
export const terminalUiLayer = (input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Layer.Layer<UiService> =>
  Layer.effect(UiService, terminalUi(input, output));

/** Asks again until the answer is not empty. `ask` is a Ui's `ask` or `askMessage`. */
export const askNonEmpty = <E>(ask: (prompt: string) => Effect.Effect<string, E>, prompt: string): Effect.Effect<string, E> =>
  Effect.gen(function* () {
    for (;;) {
      const text = yield* ask(prompt);
      if (text !== "") return text;
    }
  });
