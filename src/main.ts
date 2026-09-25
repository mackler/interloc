// Usage: node /opt/plan-review/src/main.ts "task description" [project directory]
// The project directory defaults to the current directory.
// Untested code U2 (plan step 6.2): the platform runner applied to the program with the live wiring.

import { Effect, Layer } from "effect";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { fileURLToPath } from "node:url";
import { claudePlannerLayer } from "./claude.ts";
import { codexReviewerLayer } from "./codex.ts";
import { exitCodeOf, program, type Wiring } from "./program.ts";
import { liveSdk } from "./sdkLive.ts";
import { platformLayer } from "./platform.ts";
import { terminalUi } from "./ui.ts";

const live: Wiring = {
  ui: terminalUi(process.stdin, process.stdout),
  platform: platformLayer,
  sdk: liveSdk(),
  agents: Layer.mergeAll(claudePlannerLayer, codexReviewerLayer),
  sharedConfig: fileURLToPath(new URL("../config.json", import.meta.url)),
  cwd: process.cwd(),
  usage: (text) => Effect.sync(() => void process.stderr.write(text + "\n")),
};

// On SIGINT the runner interrupts the fiber, so the finalizers run (the INTERRUPTED lines, the
// readline interface, the SDK aborts); the teardown then exits with the program's code.
NodeRuntime.runMain(Effect.scoped(program(process.argv.slice(2), live)), {
  teardown: (exit, onExit) => onExit(exitCodeOf(exit)),
});
