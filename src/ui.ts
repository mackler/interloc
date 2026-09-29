// Terminal input and output: the Ui service as a scoped resource on a pair of streams.
// ask reads one line; the answer "q" ends the run. askMessage reads one message of the interview:
// a single line is sent with Enter, and for several lines the user types """ on a line by itself,
// then the text, then """ again; the message "/quit" ends the run.

import { Effect, Layer, Ref, type Scope, Semaphore } from "effect";
import * as readline from "node:readline";
import { UserStopped } from "./errors.ts";
import { emptyFold, foldLine, parseAskLine, parseMessage } from "./input.ts";
import { interviewHelp } from "./prompts.ts";
import { analysisLines, claudeLine, questionLines } from "./render.ts";
import { viewOf } from "./analysisView.ts";
import { describeEvent } from "./uiEvents.ts";
import { Ui as UiService, type UiShape } from "./services.ts";

/**
 * The terminal Ui as a scoped resource: one readline interface on the given streams for the whole
 * run, closed when the scope closes (the end of the run or an interruption). Lines arrive as events,
 * several at once when text is pasted, and are queued until a call asks for the next one, so no
 * pasted line is lost between two calls. The end of the input ends a waiting call with UserStopped.
 * The dialogue is serialized: a second concurrent ask waits for the first to be answered (finding 20).
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
    const dialogue = yield* Semaphore.make(1);
    const questions = yield* Ref.make(0);
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
      // The terminal prints the interview's opening help (finding 8 of docs/gui-review.md), Claude Code's prose with its
      // "[claude] " prefix (issue #5) and a decision's analysis; other events print nothing.
      notify: (event) => {
        switch (event._tag) {
          case "InterviewOpened":
            return Effect.sync(() => void output.write(interviewHelp(event.heading, "terminal") + "\n"));
          case "ClaudeSaid":
            return Effect.sync(() => void output.write(claudeLine(event.text) + "\n"));
          // Issue #26: the SDK's own reconnection, and a call that succeeded after a retry (the retry itself is said).
          case "AgentReconnecting":
          case "TransportRecovered":
            return Effect.sync(() => void output.write(describeEvent(event) + "\n"));
          // S8: every question the user must answer, in the one shape, before the hint of its prompt.
          case "QuestionPresented":
            return Effect.sync(() => void output.write(questionLines(event.question).join("\n") + "\n"));
          case "DecisionAnalyzed":
            // Decision support: the terminal shows each option's arguments one after another.
            return Effect.sync(() => void output.write(analysisLines(event.decision, event.presented, viewOf(event.analysis)).join("\n") + "\n"));
          default:
            return Effect.void;
        }
      },
      nextQuestion: Ref.updateAndGet(questions, (n) => n + 1),
      ask: (prompt) =>
        Effect.gen(function* () {
          yield* showPrompt(prompt);
          const parsed = parseAskLine(yield* nextLine(prompt));
          if (parsed.kind === "quit") return yield* Effect.fail(new UserStopped({ where: prompt }));
          return parsed.text;
        }).pipe(dialogue.withPermits(1)),
      askMessage: (prompt) =>
        Effect.gen(function* () {
          yield* showPrompt(prompt);
          let fold = emptyFold;
          while (!fold.complete) fold = foldLine(fold, yield* nextLine(prompt));
          const parsed = parseMessage(fold.lines.join("\n"));
          if (parsed.kind === "quit") return yield* Effect.fail(new UserStopped({ where: prompt }));
          return parsed.text;
        }).pipe(dialogue.withPermits(1)),
    };
  });

/** The Ui service on the process streams. */
export const terminalUiLayer = (input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Layer.Layer<UiService> =>
  Layer.effect(UiService, terminalUi(input, output));
