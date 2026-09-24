// Terminal input and output. The Ui service is a scoped resource on a pair of streams; a scripted
// implementation of the Promise interface below serves the tests (and the adapters until stage 5.4).

import { Effect, Layer, type Scope } from "effect";
import * as readline from "node:readline";
import { UserStopped } from "./errors.ts";
import { liftPromise, Ui as UiService, type UiShape } from "./services.ts";

export interface Ui {
  say(text: string): void;
  /** Reads one line. The answer "q" ends the run. */
  ask(prompt: string): Promise<string>;
  /**
   * Reads one message of the interview. A single line is sent with Enter. For several lines, the
   * user types """ on a line by itself, then the text, then """ again. The message "/quit" ends the run.
   */
  askMessage(prompt: string): Promise<string>;
}

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
          const answer = (yield* nextLine(prompt)).trim();
          if (answer === "q") return yield* Effect.fail(new UserStopped({ where: prompt }));
          return answer;
        }),
      askMessage: (prompt) =>
        Effect.gen(function* () {
          yield* showPrompt(prompt);
          const collected: string[] = [];
          let block = false;
          for (;;) {
            const line = yield* nextLine(prompt);
            if (line.trim() === '"""') {
              if (block) break;
              block = true;
              continue;
            }
            collected.push(line);
            if (!block) break;
          }
          const message = collected.join("\n").trim();
          if (message === "/quit") return yield* Effect.fail(new UserStopped({ where: prompt }));
          return message;
        }),
    };
  });

/** The Ui service on the process streams. */
export const terminalUiLayer = (input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Layer.Layer<UiService> =>
  Layer.effect(UiService, terminalUi(input, output));

/** The Ui service over a Promise implementation (the scripted Ui of the tests; transitional, plan stage 5.4). */
export const uiLayer = (ui: Ui): Layer.Layer<UiService> =>
  Layer.succeed(UiService, {
    say: (text) => Effect.sync(() => ui.say(text)),
    ask: (prompt) => liftPromise<string, UserStopped>(() => ui.ask(prompt)),
    askMessage: (prompt) => liftPromise<string, UserStopped>(() => ui.askMessage(prompt)),
  });

/** A Promise Ui over the service, for the adapters until they are Effect layers (transitional, plan step 5.4). */
export const promiseUi = (ui: UiShape): Ui => ({
  say: (text) => Effect.runSync(ui.say(text)),
  ask: (prompt) => Effect.runPromise(ui.ask(prompt)),
  askMessage: (prompt) => Effect.runPromise(ui.askMessage(prompt)),
});
