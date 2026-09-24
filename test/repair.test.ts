import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Layer } from "effect";
import { plannerLayer, reviewerLayer } from "../src/agents.ts";
import { ClaudePlanner } from "../src/claude.ts";
import { CodexReviewer } from "../src/codex.ts";
import { defaultConfig } from "../src/schema.ts";
import { RunConfig, type Services } from "../src/services.ts";
import { State, storeLayer } from "../src/state.ts";
import { uiLayer } from "../src/ui.ts";
import { FakeSdk, init, messages, success, turn, type Script } from "./fakeSdk.ts";
import { finished, runFails, runTask, ScriptedPlanner, ScriptedReviewer, ScriptedUi, tempRepo, testLayer } from "./helpers.ts";

// Decision Q5: an invalid structured reply in a planning, interview or review call gets one repair
// turn in the same session or thread; a second invalid reply stops the run, and both replies are kept.
const REPAIR = /^Your structured output did not match the required schema/;
const noQuestions = { questions_for_user: [] };
const kept = (state: State, name: string): string => fs.readFileSync(path.join(state.dir, "invalid-replies", name), "utf8");
const config = { ...defaultConfig, questionPhase: false };

test("an invalid planner reply gets one repair turn and the corrected reply is used", async () => {
  const { layer, probe } = testLayer(tempRepo(), { steps: [{ output: { dispositions: "x" } }, { output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }], execs: [finished] });
  assert.equal(await runTask(layer), 1);
  assert.equal(probe.planner.prompts.length, 2);
  assert.match(probe.planner.prompts[1], REPAIR);
  assert.match(probe.planner.prompts[1], /questions_for_user/);
  assert.deepEqual(JSON.parse(kept(probe.state, "claude-1.json")), { dispositions: "x" });
  assert.deepEqual(probe.ui.asked, []);
});

test("a second invalid planner reply stops the run with AgentReplyInvalid naming both files", async () => {
  const { layer, probe } = testLayer(tempRepo(), { steps: [{ output: { dispositions: "x" } }, { output: { dispositions: "y" } }] });
  await runFails(layer, "AgentReplyInvalid", /Claude Code/, /claude-1\.json/, /claude-2\.json/);
  assert.deepEqual(JSON.parse(kept(probe.state, "claude-2.json")), { dispositions: "y" });
});

test("an invalid Codex review gets one repair turn in the same thread", async () => {
  const { layer, probe } = testLayer(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [], raw: '{"findings":[]}' }, { issues: [] }], execs: [finished] });
  assert.equal(await runTask(layer), 1);
  assert.equal(probe.reviewer.prompts.length, 2);
  assert.match(probe.reviewer.prompts[1], REPAIR);
  assert.match(probe.reviewer.prompts[1], /issues/);
  assert.deepEqual(probe.reviewer.callPhases, [1, 1]);
  assert.equal(kept(probe.state, "codex-1.json"), '{"findings":[]}');
});

test("a Codex reply that is not JSON is treated as invalid, not as a crash", async () => {
  const { layer, probe } = testLayer(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [], raw: "not json" }, { issues: [] }], execs: [finished] });
  assert.equal(await runTask(layer), 1);
  assert.match(probe.reviewer.prompts[1], REPAIR);
  assert.match(probe.reviewer.prompts[1], /JSON/);
  assert.equal(kept(probe.state, "codex-1.json"), "not json");
});

test("a second invalid Codex reply stops the run with AgentReplyInvalid naming both files", async () => {
  const { layer } = testLayer(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [], raw: "not json" }, { issues: [], raw: '{"findings":[]}' }] });
  await runFails(layer, "AgentReplyInvalid", /Codex/, /codex-1\.json/, /codex-2\.json/);
});

test("an interview turn is validated the same way", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["hello", ""],
    steps: [
      { output: { questions: [] } },
      { output: { message_to_user: 1 } },
      { output: { message_to_user: "Noted.", answered_ids: [], complete: true, summary: "# Requirements\n\nhello" } },
      { output: noQuestions, plan: "v1" },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true },
  });
  assert.equal(await runTask(layer), 1);
  assert.match(probe.planner.prompts[2], REPAIR);
  assert.match(fs.readFileSync(probe.state.requirements, "utf8"), /hello/);
  assert.deepEqual(JSON.parse(kept(probe.state, "claude-1.json")), { message_to_user: 1 });
});

// The same behaviour through the real adapters and the fake SDKs.

/** The five services with a real Codex adapter over a fake SDK and a scripted planner. */
const withCodex = (state: State, sdk: FakeSdk, planner: ScriptedPlanner): Layer.Layer<Services> =>
  Layer.mergeAll(storeLayer(state), uiLayer(new ScriptedUi([])), plannerLayer(planner), reviewerLayer(new CodexReviewer(state, config, sdk)), Layer.succeed(RunConfig, config));

test("a Codex reply without an issues array gets one repair turn in the same thread and the corrected review is used", async () => {
  const state = new State(tempRepo());
  const sdk = new FakeSdk([], [turn('{"x":1}'), turn('{"issues":[]}')]);
  const layer = withCodex(state, sdk, new ScriptedPlanner(state, [{ output: noQuestions, plan: "v1" }], [finished]));
  assert.equal(await runTask(layer), 1);
  assert.equal(sdk.threads.length, 1);
  assert.equal(sdk.threads[0].calls.length, 2);
  assert.match(sdk.threads[0].calls[1].input, REPAIR);
  assert.equal(kept(state, "codex-1.json"), '{"x":1}');
});

test("a Codex reply without an issues array twice fails with AgentReplyInvalid", async () => {
  const state = new State(tempRepo());
  const sdk = new FakeSdk([], [turn('{"x":1}'), turn('{"y":2}')]);
  const layer = withCodex(state, sdk, new ScriptedPlanner(state, [{ output: noQuestions, plan: "v1" }], []));
  await runFails(layer, "AgentReplyInvalid", /Codex/, /codex-1\.json/, /codex-2\.json/);
  assert.equal(sdk.threads[0].calls.length, 2);
});

/** A Claude Code call that writes plan.md and ends without structured output. */
const planWithoutOutput = (state: State): Script => () => (async function* () {
  fs.writeFileSync(state.plan, "v1");
  yield init("s-1");
  yield success(null, "forgot the output");
})();
const report = { status: "finished", summary: "done", question: "", remaining_work: "" };

/** The five services with a real Claude Code adapter over a fake SDK and a scripted reviewer. */
const withClaude = (state: State, sdk: FakeSdk, reviewer: ScriptedReviewer): Layer.Layer<Services> => {
  const ui = new ScriptedUi([]);
  return Layer.mergeAll(storeLayer(state), uiLayer(ui), plannerLayer(new ClaudePlanner(state, ui, config, sdk)), reviewerLayer(reviewer), Layer.succeed(RunConfig, config));
};

test("a Claude Code planning call without structured output gets one repair turn in the same session", async () => {
  const state = new State(tempRepo());
  const sdk = new FakeSdk([planWithoutOutput(state), messages(init("s-1"), success(noQuestions)), messages(init("s-1"), success(report))]);
  const layer = withClaude(state, sdk, new ScriptedReviewer(state, [{ issues: [] }]));
  assert.equal(await runTask(layer), 1);
  assert.equal(sdk.calls.length, 3);
  assert.match(sdk.calls[1].prompt, REPAIR);
  assert.equal(sdk.calls[1].options.resume, "s-1");
  assert.equal(kept(state, "claude-1.json"), "null");
});

test("a Claude Code planning call without structured output twice fails with AgentReplyInvalid", async () => {
  const state = new State(tempRepo());
  const sdk = new FakeSdk([planWithoutOutput(state), messages(init("s-1"), success(null))]);
  const layer = withClaude(state, sdk, new ScriptedReviewer(state, []));
  await runFails(layer, "AgentReplyInvalid", /Claude Code/, /claude-1\.json/, /claude-2\.json/);
  assert.equal(sdk.calls.length, 2);
});
