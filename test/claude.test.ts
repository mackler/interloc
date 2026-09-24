import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type { CanUseTool, HookCallback, HookJSONOutput, Options, PermissionResult, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { ClaudePlanner } from "../src/claude.ts";
import type { RunError } from "../src/errors.ts";
import { State } from "../src/state.ts";
import { defaultConfig, type Config } from "../src/types.ts";
import { assistantText, assistantTool, failure, FakeSdk, init, messages, success, type Script } from "./fakeSdk.ts";
import { ScriptedUi, tempRepo } from "./helpers.ts";

const planner = (scripts: Script[], answers: string[] = [], config: Partial<Config> = {}): { planner: ClaudePlanner; sdk: FakeSdk; ui: ScriptedUi; state: State } => {
  const state = new State(tempRepo());
  state.init("task");
  const ui = new ScriptedUi(answers);
  const sdk = new FakeSdk(scripts);
  return { planner: new ClaudePlanner(state, ui, { ...defaultConfig, ...config }, sdk), sdk, ui, state };
};

const schema = { type: "object", properties: {}, required: [] };
const hook = (options: Options): HookCallback => {
  const hooks = options.hooks?.PreToolUse;
  assert.ok(hooks !== undefined && hooks.length > 0, "the call registered no PreToolUse hook");
  return hooks[0].hooks[0];
};
const runHook = (options: Options, toolName: string, toolInput: Record<string, unknown> = {}): Promise<HookJSONOutput> =>
  hook(options)({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput } as PreToolUseHookInput, undefined, { signal: new AbortController().signal });
const decision = (output: HookJSONOutput): string | undefined =>
  (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;
const permission = (options: Options): CanUseTool => {
  assert.ok(options.canUseTool !== undefined, "the call registered no canUseTool");
  return options.canUseTool;
};
const tag = (e: unknown): string => (e as RunError)._tag;
// The third argument of canUseTool carries fields the adapter does not read.
const callContext = (): Parameters<CanUseTool>[2] => ({ signal: new AbortController().signal }) as Parameters<CanUseTool>[2];

test("a planning call returns the structured output and records usage", async () => {
  const fake = planner([messages(init("session-7"), assistantTool("Read", { file_path: "/x" }), success({ questions_for_user: ["q?"] }, "done"))]);
  const call = await fake.planner.planning<{ questions_for_user: string[] }>("write the plan", schema);

  assert.deepEqual(call.output.questions_for_user, ["q?"]);
  assert.equal(call.resultText, "done");
  assert.equal(call.costUsd, 0.25);
  assert.equal(fake.planner.sessionId(), "session-7");
  const usage = fs.readFileSync(path.join(fake.state.dir, "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(usage.length, 1);
  assert.deepEqual([usage[0].agent, usage[0].session_id, usage[0].num_turns, usage[0].total_cost_usd], ["claude", "session-7", 3, 0.25]);
});

test("a failed planning call fails with ClaudeCallFailed", async () => {
  const fake = planner([messages(init(), failure("error_during_execution"))]);
  await assert.rejects(fake.planner.planning("write the plan", schema), (e: unknown) => tag(e) === "ClaudeCallFailed");
});

test("a planning call without structured output fails with ClaudeCallFailed", async () => {
  const fake = planner([messages(init(), success(null, "no schema output"))]);
  await assert.rejects(fake.planner.planning("write the plan", schema), (e: unknown) => tag(e) === "ClaudeCallFailed");
});

test("the planning hook denies an edit outside plan-review/ and permits one inside", async () => {
  const fake = planner([messages(init(), success({}))]);
  await fake.planner.planning("write the plan", schema);
  const options = fake.sdk.calls[0].options;

  assert.equal(decision(await runHook(options, "Write", { file_path: path.join(fake.state.dir, "plan.md") })), undefined);
  assert.equal(decision(await runHook(options, "Write", { file_path: path.join(fake.state.project, "src/x.ts") })), "deny");
  assert.equal(decision(await runHook(options, "Edit", { file_path: "../outside.txt" })), "deny");
});

test("planning canUseTool relays AskUserQuestion to the user and returns the answers", async () => {
  const questions = [{ question: "A or B?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }];
  const relayed: (PermissionResult | null)[] = [];
  const script: Script = (call) => (async function* () {
    yield init();
    relayed.push(await permission(call.options)("AskUserQuestion", { questions }, callContext()));
    yield success({});
  })();
  const fake = planner([script], ["2"]);
  await fake.planner.planning("write the plan", schema);

  assert.deepEqual(relayed[0], { behavior: "allow", updatedInput: { questions, answers: { "A or B?": "B" } } });
  assert.match(fs.readFileSync(path.join(fake.state.dir, "conversation.md"), "utf8"), /\*\*User answer:\*\* B/);
});

test("a planning call denies every tool other than an edit or a question", async () => {
  const fake = planner([messages(init(), success({}))]);
  await fake.planner.planning("write the plan", schema);
  const result = await permission(fake.sdk.calls[0].options)("Bash", { command: "ls" }, callContext());
  assert.equal(result?.behavior, "deny");
});

test("the session id of the first call is resumed by the next call", async () => {
  const fake = planner([messages(init("session-3"), success({})), messages(init("session-3"), success({}))]);
  await fake.planner.planning("first", schema);
  await fake.planner.planning("second", schema);
  assert.equal(fake.sdk.calls[0].options.resume, undefined);
  assert.equal(fake.sdk.calls[1].options.resume, "session-3");
});

test("the configured model is passed, and no model key is set when claudeModel is null", async () => {
  const withModel = planner([messages(init(), success({}))], [], { claudeModel: "opus" });
  await withModel.planner.planning("write the plan", schema);
  assert.equal(withModel.sdk.calls[0].options.model, "opus");

  const without = planner([messages(init(), success({}))]);
  await without.planner.planning("write the plan", schema);
  assert.ok(!("model" in without.sdk.calls[0].options), "model must be absent when claudeModel is null");
});

test("a planning call passes the schema and the project directory", async () => {
  const fake = planner([messages(init(), success({}))]);
  await fake.planner.planning("write the plan", schema);
  const options = fake.sdk.calls[0].options;
  assert.deepEqual(options.outputFormat, { type: "json_schema", schema });
  assert.equal(options.cwd, fake.state.project);
  assert.equal(options.permissionMode, "default");
});

test("execution AskUserQuestion is a stop: needs_input with the answer, even without a report", async () => {
  const questions = [{ question: "A or B?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }];
  const denials: (PermissionResult | null)[] = [];
  const script: Script = (call) => (async function* () {
    yield init();
    denials.push(await permission(call.options)("AskUserQuestion", { questions }, callContext()));
    yield success(null);
  })();
  const fake = planner([script], ["A"]);
  const outcome = await fake.planner.executing("implement the plan");

  assert.equal(denials[0]?.behavior, "deny");
  assert.equal(outcome.status, "needs_input");
  assert.equal(outcome.question, "A or B?");
  assert.equal(outcome.userInput, "A or B? -> A");
  assert.equal(fake.sdk.calls[0].options.permissionMode, "auto");
});

test("after a stop, the hook denies tools but permits the final structured output", async () => {
  const questions = [{ question: "A or B?", options: [{ label: "A", description: "a" }] }];
  const seen: (string | undefined)[] = [];
  const script: Script = (call) => (async function* () {
    yield init();
    seen.push(decision(await runHook(call.options, "Write")));
    await permission(call.options)("AskUserQuestion", { questions }, callContext());
    seen.push(decision(await runHook(call.options, "Write")));
    seen.push(decision(await runHook(call.options, "Bash")));
    seen.push(decision(await runHook(call.options, "StructuredOutput")));
    yield success({ status: "needs_input", summary: "s", question: "", remaining_work: "w" });
  })();
  const fake = planner([script], ["A"]);
  await fake.planner.executing("implement the plan");
  assert.deepEqual(seen, [undefined, "deny", "deny", undefined]);
});

test("execution without a report and without a stop is aborted", async () => {
  const fake = planner([messages(init(), assistantText("working"), success(null, "text only"))]);
  const outcome = await fake.planner.executing("implement the plan");
  assert.equal(outcome.status, "aborted");
  assert.equal(outcome.summary, "text only");
});

test("an execution permission request asks the user; y allows, anything else denies", async () => {
  const results: string[] = [];
  const script: Script = (call) => (async function* () {
    yield init();
    results.push((await permission(call.options)("Bash", { command: "rm -rf /" }, callContext()))?.behavior ?? "none");
    results.push((await permission(call.options)("Bash", { command: "ls" }, callContext()))?.behavior ?? "none");
    yield success({ status: "finished", summary: "done", question: "", remaining_work: "" });
  })();
  const fake = planner([script], ["y", "n"]);
  const outcome = await fake.planner.executing("implement the plan");
  assert.deepEqual(results, ["allow", "deny"]);
  assert.equal(outcome.status, "finished");
});
