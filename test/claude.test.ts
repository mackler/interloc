import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import type { CanUseTool, HookCallback, HookJSONOutput, Options, PermissionResult, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Fiber, Layer } from "effect";
import { makeClaudePlanner } from "../src/claude.ts";
import { FileSystemError, type RunError } from "../src/errors.ts";
import { agentJsonSchema } from "../src/jsonSchema.ts";
import * as S from "../src/schema.ts";
import { type PlannerShape, RunConfig, Sdk, Store, type StoreShape, Ui } from "../src/services.ts";
import { makeStore, platformLayer } from "../src/store.ts";
import { assistantText, assistantTool, failure, FakeSdk, init, messages, success, type Script } from "./fakeSdk.ts";
import { ScriptedUi, tempRepo } from "./helpers.ts";

const run = Effect.runPromise;

/** A Claude Code planner over a fake SDK, a scripted Ui and a store on a temporary repository. */
const planner = async (scripts: Script[], answers: string[] = [], config: Partial<typeof S.Config.Type> = {}, storeOverride: Partial<StoreShape> = {}): Promise<{ planner: PlannerShape; sdk: FakeSdk; ui: ScriptedUi; dir: string; project: string }> => {
  const store = await run(makeStore(tempRepo(), []).pipe(Effect.provide(platformLayer)));
  await run(store.init("task"));
  const ui = new ScriptedUi(answers);
  const sdk = new FakeSdk(scripts);
  const deps = Layer.mergeAll(Layer.succeed(Store, { ...store, ...storeOverride }), Layer.succeed(Ui, ui), Layer.succeed(Sdk, sdk), Layer.succeed(RunConfig, { ...S.defaultConfig, ...config }));
  return { planner: await run(makeClaudePlanner.pipe(Effect.provide(deps))), sdk, ui, dir: store.dir, project: store.project };
};

// The schema of most planning calls in these tests; the output the fake returns matches it where the output is read.
const schema = S.PlanWriteResult;
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
/** Resolves when the call's abort signal fires. */
const aborted = (options: Options): Promise<void> => {
  const signal = options.abortController?.signal;
  assert.ok(signal !== undefined, "the call has no abort controller");
  return signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
};

test("a planning call returns the structured output and records usage", async () => {
  const fake = await planner([messages(init("session-7"), assistantTool("Read", { file_path: "/x" }), success({ questions_for_user: ["q?"] }, "done"))]);
  const call = await run(fake.planner.planning("write the plan", schema));

  assert.deepEqual(call.output, { questions_for_user: ["q?"] });
  assert.equal(call.resultText, "done");
  assert.equal(call.costUsd, 0.25);
  assert.equal(Effect.runSync(fake.planner.sessionId), "session-7");
  const usage = fs.readFileSync(path.join(fake.dir, "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(usage.length, 1);
  assert.deepEqual([usage[0].agent, usage[0].session_id, usage[0].num_turns, usage[0].total_cost_usd], ["claude", "session-7", 3, 0.25]);
});

test("a failed planning call fails with ClaudeCallFailed", async () => {
  const fake = await planner([messages(init(), failure("error_during_execution"))]);
  await assert.rejects(run(fake.planner.planning("write the plan", schema)), (e: unknown) => tag(e) === "ClaudeCallFailed");
});

test("a successful planning call without structured output returns it as absent to the caller", async () => {
  const fake = await planner([messages(init(), success(null, "no schema output"))]);
  const call = await run(fake.planner.planning("write the plan", schema));
  assert.equal(call.output ?? null, null);
  assert.equal(call.resultText, "no schema output");
});

test("the planning hook denies an edit outside plan-review/ and permits one inside", async () => {
  const fake = await planner([messages(init(), success({}))]);
  await run(fake.planner.planning("write the plan", schema));
  const options = fake.sdk.calls[0].options;

  assert.equal(decision(await runHook(options, "Write", { file_path: path.join(fake.dir, "plan.md") })), undefined);
  assert.equal(decision(await runHook(options, "Write", { file_path: path.join(fake.project, "src/x.ts") })), "deny");
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
  const fake = await planner([script], ["2"]);
  await run(fake.planner.planning("write the plan", schema));

  assert.deepEqual(relayed[0], { behavior: "allow", updatedInput: { questions, answers: { "A or B?": "B" } } });
  assert.match(fs.readFileSync(path.join(fake.dir, "conversation.md"), "utf8"), /\*\*User answer:\*\* B/);
});

test("a planning call denies every tool other than an edit or a question", async () => {
  const fake = await planner([messages(init(), success({}))]);
  await run(fake.planner.planning("write the plan", schema));
  const result = await permission(fake.sdk.calls[0].options)("Bash", { command: "ls" }, callContext());
  assert.equal(result?.behavior, "deny");
});

test("the session id of the first call is resumed by the next call", async () => {
  const fake = await planner([messages(init("session-3"), success({})), messages(init("session-3"), success({}))]);
  await run(fake.planner.planning("first", schema));
  await run(fake.planner.planning("second", schema));
  assert.equal(fake.sdk.calls[0].options.resume, undefined);
  assert.equal(fake.sdk.calls[1].options.resume, "session-3");
});

test("the configured model is passed, and no model key is set when claudeModel is null", async () => {
  const withModel = await planner([messages(init(), success({}))], [], { claudeModel: "opus" });
  await run(withModel.planner.planning("write the plan", schema));
  assert.equal(withModel.sdk.calls[0].options.model, "opus");

  const without = await planner([messages(init(), success({}))]);
  await run(without.planner.planning("write the plan", schema));
  assert.ok(!("model" in without.sdk.calls[0].options), "model must be absent when claudeModel is null");
});

test("the planning call passes the agent JSON Schema of the given Effect schema as outputFormat, and the project directory", async () => {
  const fake = await planner([messages(init(), success({}))]);
  await run(fake.planner.planning("write the plan", S.PlannerResponse));
  const options = fake.sdk.calls[0].options;
  assert.deepEqual(options.outputFormat, { type: "json_schema", schema: agentJsonSchema(S.PlannerResponse) });
  assert.equal(options.cwd, fake.project);
  assert.equal(options.permissionMode, "default");
});

test("the execution call passes the agent JSON Schema of ExecReport as outputFormat", async () => {
  const fake = await planner([messages(init(), success({ status: "finished", summary: "done", question: "", remaining_work: "" }))]);
  await run(fake.planner.executing("implement the plan"));
  assert.deepEqual(fake.sdk.calls[0].options.outputFormat, { type: "json_schema", schema: agentJsonSchema(S.ExecReport) });
});

test("execution AskUserQuestion is a stop: needs_input with the answer, even without a report", async () => {
  const questions = [{ question: "A or B?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }];
  const denials: (PermissionResult | null)[] = [];
  const script: Script = (call) => (async function* () {
    yield init();
    denials.push(await permission(call.options)("AskUserQuestion", { questions }, callContext()));
    yield success(null);
  })();
  const fake = await planner([script], ["A"]);
  const outcome = await run(fake.planner.executing("implement the plan"));

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
  const fake = await planner([script], ["A"]);
  await run(fake.planner.executing("implement the plan"));
  assert.deepEqual(seen, [undefined, "deny", "deny", undefined]);
});

test("an invalid execution report after a recorded stop still yields needs_input with the user's answer", async () => {
  const questions = [{ question: "A or B?", options: [{ label: "A", description: "a" }] }];
  const script: Script = (call) => (async function* () {
    yield init();
    await permission(call.options)("AskUserQuestion", { questions }, callContext());
    yield success({ status: "bogus", summary: 7 });
  })();
  const fake = await planner([script], ["A"]);
  const outcome = await run(fake.planner.executing("implement the plan"));
  assert.equal(outcome.status, "needs_input");
  assert.equal(outcome.userInput, "A or B? -> A");
  assert.equal(outcome.summary, "");
  assert.equal(fake.sdk.calls.length, 1);
});

test("an invalid execution report without a stop yields aborted, and no repair prompt is sent", async () => {
  const fake = await planner([messages(init(), success({ status: "bogus" }, "text only"))]);
  const outcome = await run(fake.planner.executing("implement the plan"));
  assert.equal(outcome.status, "aborted");
  assert.equal(outcome.summary, "text only");
  assert.match(outcome.question, /ended without a status report/);
  assert.equal(fake.sdk.calls.length, 1);
});

test("execution without a report and without a stop is aborted", async () => {
  const fake = await planner([messages(init(), assistantText("working"), success(null, "text only"))]);
  const outcome = await run(fake.planner.executing("implement the plan"));
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
  const fake = await planner([script], ["y", "n"]);
  const outcome = await run(fake.planner.executing("implement the plan"));
  assert.deepEqual(results, ["allow", "deny"]);
  assert.equal(outcome.status, "finished");
});

test("interrupting a planning call aborts the Agent SDK call", async () => {
  let sawAbort = false;
  const script: Script = (call) => (async function* () {
    yield init();
    await aborted(call.options);
    sawAbort = true;
    throw new Error("The operation was aborted");
  })();
  const fake = await planner([script]);
  const reached = fake.sdk.nextCall();
  const fiber = Effect.runFork(fake.planner.planning("write the plan", schema));
  await reached;
  await sleep(10);
  await run(Fiber.interrupt(fiber));
  assert.equal(sawAbort, true, "the SDK call was not aborted");
});

test("a UserStopped inside canUseTool ends the call with UserStopped", async () => {
  const script: Script = (call) => (async function* () {
    yield init();
    try {
      await permission(call.options)("Bash", { command: "ls" }, callContext());
    } catch {
      // The adapter answers the SDK; the failure reaches the caller of the call.
    }
    if (call.options.abortController !== undefined) await aborted(call.options);
    yield success({ status: "finished", summary: "done", question: "", remaining_work: "" });
  })();
  const fake = await planner([script], ["q"]);
  await assert.rejects(run(fake.planner.executing("implement the plan")), (e: unknown) => tag(e) === "UserStopped");
});

test("a failure while recording usage aborts the SDK call, closes its stream, and fails the call with that error", async () => {
  // Found by a Codex review: a typed failure inside the message loop left the iterator open and
  // the call un-aborted, so the Claude Code process could outlive the HALTED message.
  let closed = false;
  const script: Script = (call) => (async function* () {
    try {
      yield init();
      yield success({});
      await aborted(call.options);
    } finally {
      closed = true;
    }
  })();
  const failing: Partial<StoreShape> = { recordUsage: () => Effect.fail(new FileSystemError({ operation: "append to", path: "usage.jsonl", message: "disk full" })) };
  const fake = await planner([script], [], {}, failing);
  await assert.rejects(run(fake.planner.planning("write the plan", schema)), (e: unknown) => tag(e) === "FileSystemError");
  assert.equal(closed, true, "the SDK stream was not closed");
  assert.equal(fake.sdk.calls[0].options.abortController?.signal.aborted, true, "the SDK call was not aborted");
});

test("an SDK that fails to start is a call error: ClaudeCallFailed for planning, aborted for execution", async () => {
  // Found by a Codex review: a synchronous throw of sdk.query (for example a missing CLI binary)
  // became a defect that bypassed the HALTED output and the aborted outcome.
  const failing: Script = () => {
    throw new Error("spawn claude ENOENT");
  };
  const planning = await planner([failing]);
  await assert.rejects(run(planning.planner.planning("write the plan", schema)), (e: unknown) => tag(e) === "ClaudeCallFailed" && /spawn claude ENOENT/.test(String((e as { message: string }).message)));
  const executing = await planner([failing]);
  const outcome = await run(executing.planner.executing("implement the plan"));
  assert.equal(outcome.status, "aborted");
  assert.match(outcome.question, /spawn claude ENOENT/);
});

// Finding 18 of docs/functional-design-review.md: parseInt accepted a prefix, so "1 please explain" chose option 1.
test("only a whole in-range number chooses an option; anything else is the answer as typed", async () => {
  const questions = [{ question: "A or B?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }];
  const answersFor = async (reply: string): Promise<string> => {
    let relayed: Record<string, string> = {};
    const script: Script = (call) => (async function* () {
      yield init();
      const result = await permission(call.options)("AskUserQuestion", { questions }, callContext());
      relayed = ((result as { updatedInput?: { answers?: Record<string, string> } }).updatedInput?.answers) ?? {};
      yield success({});
    })();
    const fake = await planner([script], [reply]);
    await run(fake.planner.planning("write the plan", schema));
    return relayed["A or B?"] ?? "";
  };
  assert.equal(await answersFor("1 please explain"), "1 please explain");
  assert.equal(await answersFor("1.5"), "1.5");
  assert.equal(await answersFor("0"), "0");
  assert.equal(await answersFor("3"), "3");
  assert.equal(await answersFor(" 2 "), "B");
});
