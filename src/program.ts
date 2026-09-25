// The program: arguments, configuration, the live services, the run, and what is printed at the
// end. main.ts applies the platform runner to it; the tests run it with scripted services.

import { Cause, Context, Effect, Exit, Layer, Option, type Scope } from "effect";
import * as path from "node:path";
import { describe } from "./errors.ts";
import { run } from "./run.ts";
import type { AgentSdk } from "./sdk.ts";
import { Planner, type Reviewer, RunConfig, Sdk, Store, type StoreShape, Ui, type UiShape } from "./services.ts";
import { loadConfig, makeStore, type Platform } from "./store.ts";
import { renderUsage } from "./usage.ts";

/** What the program is wired to: the terminal, the platform, the SDKs and the agents. */
export type Wiring = {
  /** The Ui of the run; a scoped resource (live: the terminal on the process streams). */
  ui: Effect.Effect<UiShape, never, Scope.Scope>;
  /** The platform services (live: platformLayer). */
  platform: Layer.Layer<Platform>;
  /** The two SDKs (live: liveSdk). */
  sdk: AgentSdk;
  /** The planner and the reviewer over the services (live: the Claude Code and Codex layers). */
  agents: Layer.Layer<Planner | Reviewer, never, Sdk | Ui | Store | RunConfig>;
  /** The shared config file (live: config.json of this repository). */
  sharedConfig: string;
  /** The project directory when the arguments name none (live: process.cwd()). */
  cwd: string;
  /** Where the usage text goes when there is no task (live: stderr). */
  usage: (text: string) => Effect.Effect<void>;
};

export const USAGE = 'usage: node main.ts "task description" [project directory]';

/**
 * Runs the program and returns the exit code; everything else is printed through the Ui.
 * A typed error of the run prints HALTED and gives 1. An interruption (Ctrl+C) prints INTERRUPTED
 * from a finalizer and leaves the fiber interrupted; `exitCodeOf` turns that into 130. In every
 * case the Claude Code session id and the usage summary are printed last.
 */
export const program = (args: readonly string[], wiring: Wiring): Effect.Effect<number, never, Scope.Scope> =>
  Effect.gen(function* () {
    const task = args[0];
    if (task === undefined || task === "") {
      yield* wiring.usage(USAGE);
      return 2;
    }
    const project = path.resolve(args[1] ?? wiring.cwd);
    const dir = path.join(project, "plan-review");
    const ui = yield* wiring.ui;
    const store = (ignorePaths: readonly string[]) => makeStore(project, ignorePaths).pipe(Effect.provide(wiring.platform));

    /** The last two lines of every ending. */
    const tail = (sessionId: string | null, records: StoreShape) =>
      Effect.gen(function* () {
        yield* ui.say(`Claude Code session id: ${sessionId ?? "none"}`);
        const usage = yield* records.usageSummary().pipe(Effect.map(renderUsage), Effect.catch((e) => Effect.succeed(`unavailable: ${describe(e)}`)));
        yield* ui.say(`Usage: ${usage}`);
      });
    const halted = (reason: string, sessionId: string | null, records: StoreShape) =>
      Effect.gen(function* () {
        yield* ui.say(`\nHALTED: ${reason}\nState is preserved in ${dir}.`);
        yield* tail(sessionId, records);
        return 1;
      });

    // The configuration, before any agent exists and before the records are initialised (Q4).
    const configExit = yield* Effect.exit(loadConfig(project, wiring.sharedConfig).pipe(Effect.provide(wiring.platform)));
    if (Exit.isFailure(configExit)) {
      const error = Cause.findErrorOption(configExit.cause);
      if (Option.isNone(error)) return yield* Effect.die(Cause.squash(configExit.cause));
      return yield* halted(describe(error.value), null, yield* store([]));
    }
    const config = configExit.value;

    const records = yield* store(config.ignorePaths);
    const base = Layer.mergeAll(Layer.succeed(Store, records), Layer.succeed(Ui, ui), Layer.succeed(RunConfig, config), Layer.succeed(Sdk, wiring.sdk));
    // Built once, so that the planner whose session id is printed is the one the run used.
    const context = yield* Layer.build(Layer.provideMerge(wiring.agents, base));
    const sessionId = Context.get(context, Planner).sessionId;

    const interrupted = Effect.gen(function* () {
      yield* ui.say(`\nINTERRUPTED by the user. State is preserved in ${dir}.`);
      yield* records.converse("**Interrupted by the user.**\n").pipe(Effect.ignore);
      yield* tail(yield* sessionId, records);
    });
    const exit = yield* run(task).pipe(Effect.provide(context), Effect.onInterrupt(() => interrupted), Effect.exit);

    if (Exit.isSuccess(exit)) {
      yield* ui.say(`\nClaude Code reports that the task is finished after ${exit.value} execution phase(s).`);
      yield* ui.say(`Plan: ${records.plan}\nConversation record: ${records.dir}/conversation.md`);
      yield* tail(yield* sessionId, records);
      return 0;
    }
    const error = Cause.findErrorOption(exit.cause);
    if (Option.isNone(error)) return yield* Effect.die(Cause.squash(exit.cause));
    return yield* halted(describe(error.value), yield* sessionId, records);
  });

/**
 * The exit code for the program's exit: its own code, 130 when it was interrupted, 1 for a defect or
 * any other failure. Typed loosely, because the runner's Teardown is generic over the exit.
 */
export const exitCodeOf = (exit: Exit.Exit<unknown, unknown>): number => {
  if (Exit.isSuccess(exit)) return typeof exit.value === "number" ? exit.value : 0;
  return Cause.hasInterruptsOnly(exit.cause) ? 130 : 1;
};
