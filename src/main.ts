// Usage: node /opt/plan-review/src/main.ts "task description" [project directory]
// The project directory defaults to the current directory.

import { Effect, Layer } from "effect";
import { plannerLayer, reviewerLayer } from "./agents.ts";
import { ClaudePlanner } from "./claude.ts";
import { CodexReviewer } from "./codex.ts";
import { haltMessage } from "./errors.ts";
import { run } from "./run.ts";
import { liveSdk } from "./sdkLive.ts";
import { RunConfig, Ui } from "./services.ts";
import { State } from "./state.ts";
import { platformLayer, storeLayer } from "./store.ts";
import { promiseUi, terminalUi } from "./ui.ts";

const task = process.argv[2];
if (!task) {
  console.error('usage: node main.ts "task description" [project directory]');
  process.exit(2);
}

const state = new State(process.argv[3] ?? process.cwd());
const say = (text: string): void => void process.stdout.write(text + "\n");
// Undefined until the configuration is valid: an invalid config.json halts before any agent exists.
let planner: ClaudePlanner | undefined;

try {
  const config = state.loadConfig();
  // The terminal Ui is a scoped resource; the scope closes when the run ends or is interrupted.
  const program = Effect.gen(function* () {
    const ui = yield* terminalUi(process.stdin, process.stdout);
    planner = new ClaudePlanner(state, promiseUi(ui), config, liveSdk);
    const store = Layer.provide(storeLayer(state.project, config.ignorePaths), platformLayer);
    const live = Layer.mergeAll(store, Layer.succeed(Ui, ui), plannerLayer(planner), reviewerLayer(new CodexReviewer(state, config, liveSdk)), Layer.succeed(RunConfig, config));
    return yield* run(task).pipe(Effect.provide(live));
  });
  // A typed failure rejects with the error object itself, which haltMessage recognises.
  const phases = await Effect.runPromise(Effect.scoped(program));
  say(`\nClaude Code reports that the task is finished after ${phases} execution phase(s).`);
  say(`Plan: ${state.plan}\nConversation record: ${state.dir}/conversation.md`);
} catch (e) {
  const message = haltMessage(e);
  if (message === null) throw e;
  say(`\n${message}\nState is preserved in ${state.dir}.`);
  process.exitCode = 1;
} finally {
  say(`Claude Code session id: ${planner?.sessionId() ?? "none"}`);
  say(`Usage: ${state.usageSummary()}`);
}
