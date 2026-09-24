import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { ClaudePlanner } from "../src/claude.ts";
import { CodexReviewer } from "../src/codex.ts";
import type { RunError } from "../src/errors.ts";
import { describe } from "../src/errors.ts";
import type { Context } from "../src/review.ts";
import { run } from "../src/run.ts";
import { defaultConfig } from "../src/schema.ts";
import { State } from "../src/state.ts";
import { FakeSdk, init, messages, success, turn, type Script } from "./fakeSdk.ts";
import { context, finished, ScriptedPlanner, ScriptedReviewer, ScriptedUi, tempRepo } from "./helpers.ts";

// Decision Q5: an invalid structured reply in a planning, interview or review call gets one repair
// turn in the same session or thread; a second invalid reply stops the run, and both replies are kept.
const REPAIR = /^Your structured output did not match the required schema/;
const noQuestions = { questions_for_user: [] };
const kept = (state: State, name: string): string => fs.readFileSync(path.join(state.dir, "invalid-replies", name), "utf8");
const config = { ...defaultConfig, questionPhase: false };

const rejectsWith = async (promise: Promise<unknown>, tag: RunError["_tag"], ...texts: RegExp[]): Promise<void> => {
  await assert.rejects(promise, (e: unknown) => {
    const error = e as RunError;
    assert.equal(error._tag, tag);
    for (const text of texts) assert.match(describe(error), text);
    return true;
  });
};

test("an invalid planner reply gets one repair turn and the corrected reply is used", async () => {
  const ui = new ScriptedUi([]);
  const ctx = context(tempRepo(), ui, [{ output: { dispositions: "x" } }, { output: noQuestions, plan: "v1" }], [{ issues: [] }], [finished]);
  assert.equal(await run(ctx, "task"), 1);
  assert.equal(ctx.planner.prompts.length, 2);
  assert.match(ctx.planner.prompts[1], REPAIR);
  assert.match(ctx.planner.prompts[1], /questions_for_user/);
  assert.deepEqual(JSON.parse(kept(ctx.state, "claude-1.json")), { dispositions: "x" });
  assert.deepEqual(ui.asked, []);
});

test("a second invalid planner reply stops the run with AgentReplyInvalid naming both files", async () => {
  const ctx = context(tempRepo(), new ScriptedUi([]), [{ output: { dispositions: "x" } }, { output: { dispositions: "y" } }], [], []);
  await rejectsWith(run(ctx, "task"), "AgentReplyInvalid", /Claude Code/, /claude-1\.json/, /claude-2\.json/);
  assert.deepEqual(JSON.parse(kept(ctx.state, "claude-2.json")), { dispositions: "y" });
});

test("an invalid Codex review gets one repair turn in the same thread", async () => {
  const ctx = context(tempRepo(), new ScriptedUi([]), [{ output: noQuestions, plan: "v1" }], [{ issues: [], raw: '{"findings":[]}' }, { issues: [] }], [finished]);
  assert.equal(await run(ctx, "task"), 1);
  assert.equal(ctx.reviewer.prompts.length, 2);
  assert.match(ctx.reviewer.prompts[1], REPAIR);
  assert.match(ctx.reviewer.prompts[1], /issues/);
  assert.deepEqual(ctx.reviewer.callPhases, [1, 1]);
  assert.equal(kept(ctx.state, "codex-1.json"), '{"findings":[]}');
});

test("a Codex reply that is not JSON is treated as invalid, not as a crash", async () => {
  const ctx = context(tempRepo(), new ScriptedUi([]), [{ output: noQuestions, plan: "v1" }], [{ issues: [], raw: "not json" }, { issues: [] }], [finished]);
  assert.equal(await run(ctx, "task"), 1);
  assert.match(ctx.reviewer.prompts[1], REPAIR);
  assert.match(ctx.reviewer.prompts[1], /JSON/);
  assert.equal(kept(ctx.state, "codex-1.json"), "not json");
});

test("a second invalid Codex reply stops the run with AgentReplyInvalid naming both files", async () => {
  const ctx = context(tempRepo(), new ScriptedUi([]), [{ output: noQuestions, plan: "v1" }], [{ issues: [], raw: "not json" }, { issues: [], raw: '{"findings":[]}' }], []);
  await rejectsWith(run(ctx, "task"), "AgentReplyInvalid", /Codex/, /codex-1\.json/, /codex-2\.json/);
});

test("an interview turn is validated the same way", async () => {
  const ui = new ScriptedUi(["hello", ""]);
  const ctx = context(tempRepo(), ui,
    [
      { output: { questions: [] } },
      { output: { message_to_user: 1 } },
      { output: { message_to_user: "Noted.", answered_ids: [], complete: true, summary: "# Requirements\n\nhello" } },
      { output: noQuestions, plan: "v1" },
    ],
    [{ issues: [] }, { issues: [] }, { issues: [] }], [finished], { questionPhase: true });
  assert.equal(await run(ctx, "task"), 1);
  assert.match(ctx.planner.prompts[2], REPAIR);
  assert.match(fs.readFileSync(ctx.state.requirements, "utf8"), /hello/);
  assert.deepEqual(JSON.parse(kept(ctx.state, "claude-1.json")), { message_to_user: 1 });
});

// The same behaviour through the real adapters and the fake SDKs.

test("a Codex reply without an issues array gets one repair turn in the same thread and the corrected review is used", async () => {
  const state = new State(tempRepo());
  const ui = new ScriptedUi([]);
  const sdk = new FakeSdk([], [turn('{"x":1}'), turn('{"issues":[]}')]);
  const planner = new ScriptedPlanner(state, [{ output: noQuestions, plan: "v1" }], [finished]);
  const ctx: Context = { state, ui, planner, reviewer: new CodexReviewer(state, config, sdk), config };
  assert.equal(await run(ctx, "task"), 1);
  assert.equal(sdk.threads.length, 1);
  assert.equal(sdk.threads[0].calls.length, 2);
  assert.match(sdk.threads[0].calls[1].input, REPAIR);
  assert.equal(kept(state, "codex-1.json"), '{"x":1}');
});

test("a Codex reply without an issues array twice fails with AgentReplyInvalid", async () => {
  const state = new State(tempRepo());
  const sdk = new FakeSdk([], [turn('{"x":1}'), turn('{"y":2}')]);
  const planner = new ScriptedPlanner(state, [{ output: noQuestions, plan: "v1" }], []);
  const ctx: Context = { state, ui: new ScriptedUi([]), planner, reviewer: new CodexReviewer(state, config, sdk), config };
  await rejectsWith(run(ctx, "task"), "AgentReplyInvalid", /Codex/, /codex-1\.json/, /codex-2\.json/);
  assert.equal(sdk.threads[0].calls.length, 2);
});

/** A Claude Code call that writes plan.md and ends without structured output. */
const planWithoutOutput = (state: State): Script => () => (async function* () {
  fs.writeFileSync(state.plan, "v1");
  yield init("s-1");
  yield success(null, "forgot the output");
})();
const report = { status: "finished", summary: "done", question: "", remaining_work: "" };

test("a Claude Code planning call without structured output gets one repair turn in the same session", async () => {
  const state = new State(tempRepo());
  const ui = new ScriptedUi([]);
  const sdk = new FakeSdk([planWithoutOutput(state), messages(init("s-1"), success(noQuestions)), messages(init("s-1"), success(report))]);
  const ctx: Context = { state, ui, planner: new ClaudePlanner(state, ui, config, sdk), reviewer: new ScriptedReviewer(state, [{ issues: [] }]), config };
  assert.equal(await run(ctx, "task"), 1);
  assert.equal(sdk.calls.length, 3);
  assert.match(sdk.calls[1].prompt, REPAIR);
  assert.equal(sdk.calls[1].options.resume, "s-1");
  assert.equal(kept(state, "claude-1.json"), "null");
});

test("a Claude Code planning call without structured output twice fails with AgentReplyInvalid", async () => {
  const state = new State(tempRepo());
  const ui = new ScriptedUi([]);
  const sdk = new FakeSdk([planWithoutOutput(state), messages(init("s-1"), success(null))]);
  const ctx: Context = { state, ui, planner: new ClaudePlanner(state, ui, config, sdk), reviewer: new ScriptedReviewer(state, []), config };
  await rejectsWith(run(ctx, "task"), "AgentReplyInvalid", /Claude Code/, /claude-1\.json/, /claude-2\.json/);
  assert.equal(sdk.calls.length, 2);
});
