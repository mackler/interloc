// The server of the end-to-end tests (plan step 5.1): the real web server and run manager over the scripted
// agents of test/helpers.ts, in a temporary repository, so that no agent is reached. SCENARIO chooses the script
// of every run: "converge" (one accepted issue, then convergence), "decision" (a question from Claude Code),
// "stop" (a planning call that waits until it is interrupted). PORT is the port.

import { Effect } from "effect";
import { HttpServer } from "effect/unstable/http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { platformLayer } from "../src/platform.ts";
import { makeRunManager } from "../src/runManager.ts";
import { makeWebServer } from "../src/webServer.ts";
import { finished, issue, respond, type TestOptions, tempRepo, testWiring } from "../test/helpers.ts";

const noQuestions = { questions_for_user: [] };
export const SCENARIOS: Record<string, TestOptions> = {
  converge: {
    steps: [{ output: noQuestions, plan: "1. [ ] the step\n" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "1. [ ] the step, amended\n" }],
    reviews: [{ issues: [issue("P1-R1-1", "The step names no file.")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  },
  decision: {
    steps: [{ output: { questions_for_user: ["Which database should the service use?"] }, plan: "1. [ ] the step\n" }, { output: noQuestions }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
  },
  stop: { steps: [{ output: noQuestions, plan: "1. [ ] the step\n" }, { hang: true }], reviews: [{ issues: [issue("P1-R1-1")] }] },
};

const scenario = SCENARIOS[process.env.SCENARIO ?? "converge"] ?? SCENARIOS.converge;
const port = Number(process.env.PORT ?? "8101");
const repo = tempRepo();
const distDir = fileURLToPath(new URL("../web/dist", import.meta.url));

const main = Effect.gen(function* () {
  const manager = yield* makeRunManager((ui) => ({ ...testWiring(repo, scenario).wiring, ui: Effect.succeed(ui) }), repo, `e2e-${process.env.SCENARIO ?? "converge"}`);
  // As src/web.ts: the tabs are closed by a finalizer registered after serveEffect, so it runs first (finding 15).
  const web = yield* makeWebServer(manager, distDir);
  yield* HttpServer.serveEffect(web.handler);
  yield* Effect.addFinalizer(() => web.closeAll);
  yield* Effect.sync(() => void process.stdout.write(`e2e server (${process.env.SCENARIO ?? "converge"}) on http://127.0.0.1:${port}/ in ${repo}\n`));
  return yield* Effect.never;
}).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layer(() => createServer(), { port })), Effect.provide(platformLayer));

NodeRuntime.runMain(main);
