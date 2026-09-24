// Usage: node /opt/plan-review/src/main.ts "task description" [project directory]
// The project directory defaults to the current directory.

import { Effect, Layer } from "effect";
import { plannerLayer, reviewerLayer } from "./agents.ts";
import { ClaudePlanner } from "./claude.ts";
import { CodexReviewer } from "./codex.ts";
import { haltMessage } from "./errors.ts";
import { run } from "./run.ts";
import { liveSdk } from "./sdkLive.ts";
import { RunConfig } from "./services.ts";
import { State, storeLayer } from "./state.ts";
import { TerminalUi, uiLayer } from "./ui.ts";

const task = process.argv[2];
if (!task) {
  console.error('usage: node main.ts "task description" [project directory]');
  process.exit(2);
}

const state = new State(process.argv[3] ?? process.cwd());
const ui = new TerminalUi();
// Undefined until the configuration is valid: an invalid config.json halts before any agent exists.
let planner: ClaudePlanner | undefined;

try {
  const config = state.loadConfig();
  planner = new ClaudePlanner(state, ui, config, liveSdk);
  const live = Layer.mergeAll(storeLayer(state), uiLayer(ui), plannerLayer(planner), reviewerLayer(new CodexReviewer(state, config, liveSdk)), Layer.succeed(RunConfig, config));
  // A typed failure rejects with the error object itself, which haltMessage recognises.
  const phases = await Effect.runPromise(run(task).pipe(Effect.provide(live)));
  ui.say(`\nClaude Code reports that the task is finished after ${phases} execution phase(s).`);
  ui.say(`Plan: ${state.plan}\nConversation record: ${state.dir}/conversation.md`);
} catch (e) {
  const message = haltMessage(e);
  if (message === null) throw e;
  ui.say(`\n${message}\nState is preserved in ${state.dir}.`);
  process.exitCode = 1;
} finally {
  ui.say(`Claude Code session id: ${planner?.sessionId() ?? "none"}`);
  ui.say(`Usage: ${state.usageSummary()}`);
}
