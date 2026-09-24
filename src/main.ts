// Usage: node /opt/plan-review/src/main.ts "task description" [project directory]
// The project directory defaults to the current directory.

import { ClaudePlanner } from "./claude.ts";
import { CodexReviewer } from "./codex.ts";
import { liveSdk } from "./sdkLive.ts";
import type { Context } from "./review.ts";
import { run } from "./run.ts";
import { haltMessage } from "./errors.ts";
import { State } from "./state.ts";
import { TerminalUi } from "./ui.ts";

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
  const ctx: Context = { state, ui, planner, reviewer: new CodexReviewer(state, config, liveSdk), config };
  const phases = await run(ctx, task);
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
