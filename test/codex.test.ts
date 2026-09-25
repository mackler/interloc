import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import type { TurnOptions } from "@openai/codex-sdk";
import { Cause, Effect, Exit, Fiber, Layer, Option } from "effect";
import { makeCodexReviewer } from "../src/codex.ts";
import { describe, type RunError } from "../src/errors.ts";
import type { AgentSdk } from "../src/sdk.ts";
import { agentJsonSchema } from "../src/jsonSchema.ts";
import * as S from "../src/schema.ts";
import { type ReviewerShape, RunConfig, Sdk, Store } from "../src/services.ts";
import { makeStore, platformLayer } from "../src/store.ts";
import { FakeSdk, turn, type TurnAnswer } from "./fakeSdk.ts";
import { tempRepo } from "./helpers.ts";

const run = Effect.runPromise;

/** A Codex reviewer over a fake SDK and a store on a temporary repository. */
const reviewer = async (turns: TurnAnswer[], config: Partial<typeof S.Config.Type> = {}): Promise<{ reviewer: ReviewerShape; sdk: FakeSdk; dir: string; project: string }> => {
  const store = await run(makeStore(tempRepo(), []).pipe(Effect.provide(platformLayer)));
  await run(store.init("task"));
  const sdk = new FakeSdk([], turns);
  const deps = Layer.mergeAll(Layer.succeed(Store, store), Layer.succeed(Sdk, sdk), Layer.succeed(RunConfig, { ...S.defaultConfig, ...config }));
  return { reviewer: await run(makeCodexReviewer.pipe(Effect.provide(deps))), sdk, dir: store.dir, project: store.project };
};

const tag = (e: unknown): string => (e as RunError)._tag;

test("startPhase starts a thread with danger-full-access, approval never, the project as working directory", async () => {
  const fake = await reviewer([]);
  await run(fake.reviewer.startPhase);
  assert.equal(fake.sdk.threads.length, 1);
  assert.deepEqual(fake.sdk.threads[0].options, {
    workingDirectory: fake.project,
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
  });
});

test("the configured model is passed, and no model key is set when codexModel is null", async () => {
  const withModel = await reviewer([], { codexModel: "gpt-x" });
  await run(withModel.reviewer.startPhase);
  assert.equal(withModel.sdk.threads[0].options?.model, "gpt-x");

  const without = await reviewer([]);
  await run(without.reviewer.startPhase);
  assert.ok(!("model" in (without.sdk.threads[0].options ?? {})), "model must be absent when codexModel is null");
});

test("review passes agentJsonSchema(Review) as outputSchema and records usage", async () => {
  const fake = await reviewer([turn(JSON.stringify({ issues: [{ id: "A", severity: "major", location: "l", problem: "p", evidence: "e" }] }))]);
  const session = await run(fake.reviewer.startPhase);
  const text = await run(session.review("review the plan"));

  assert.deepEqual(JSON.parse(text).issues.map((i: { id: string }) => i.id), ["A"]);
  assert.deepEqual(fake.sdk.threads[0].calls[0].turnOptions?.outputSchema, agentJsonSchema(S.Review));
  assert.equal(fake.sdk.threads[0].calls[0].input, "review the plan");
  const usage = JSON.parse(fs.readFileSync(path.join(fake.dir, "usage.jsonl"), "utf8").trim());
  assert.equal(usage.agent, "codex");
  assert.equal(usage.version, 2);
  assert.equal(usage.thread, "thread-1");
  assert.deepEqual([usage.input_tokens, usage.output_tokens], [10, 5]);
});

test("a failed turn fails with CodexCallFailed", async () => {
  const fake = await reviewer([new Error("the model is overloaded")]);
  const session = await run(fake.reviewer.startPhase);
  await assert.rejects(run(session.review("review the plan")), (e: unknown) => tag(e) === "CodexCallFailed");
});

test("the reviewer returns a reply without an issues array unchanged to the caller", async () => {
  const fake = await reviewer([turn(JSON.stringify({ findings: [] }))]);
  const session = await run(fake.reviewer.startPhase);
  assert.equal(await run(session.review("review the plan")), JSON.stringify({ findings: [] }));
});

// Finding 11 / recommendation C: the session is a value bound to its thread, not a nullable Ref in the adapter.
test("each startPhase returns a session bound to its own thread, and calls do not cross", async () => {
  const empty = JSON.stringify({ issues: [] });
  const fake = await reviewer([turn(empty), turn(empty), turn(empty)]);
  const first = await run(fake.reviewer.startPhase);
  const second = await run(fake.reviewer.startPhase);
  await run(second.review("second phase"));
  await run(first.review("first phase"));
  await run(first.review("first phase again"));

  assert.equal(fake.sdk.threads.length, 2);
  assert.deepEqual(fake.sdk.threads[0].calls.map((c) => c.input), ["first phase", "first phase again"]);
  assert.deepEqual(fake.sdk.threads[1].calls.map((c) => c.input), ["second phase"]);
});

// Finding 11 of docs/functional-design-review.md: startup failures were defects, not typed errors.
const typedFailure = async (effect: Effect.Effect<unknown, RunError>): Promise<RunError> => {
  const exit = await Effect.runPromiseExit(effect);
  assert.ok(Exit.isFailure(exit), "the effect succeeded");
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(Option.isSome(error), `a defect, not a typed error: ${Cause.pretty(exit.cause)}`);
  return error.value;
};

test("a startThread that throws makes startPhase fail with CodexCallFailed, not a defect", async () => {
  const store = await run(makeStore(tempRepo(), []).pipe(Effect.provide(platformLayer)));
  const fake = new FakeSdk();
  const sdk: AgentSdk = { query: (params) => fake.query(params), startThread: () => { throw new Error("spawn codex ENOENT"); } };
  const deps = Layer.mergeAll(Layer.succeed(Store, store), Layer.succeed(Sdk, sdk), Layer.succeed(RunConfig, S.defaultConfig));
  const codex = await run(makeCodexReviewer.pipe(Effect.provide(deps)));
  const error = await typedFailure(codex.startPhase);
  assert.equal(error._tag, "CodexCallFailed");
  assert.match(describe(error), /spawn codex ENOENT/);
});

test("interrupting a review aborts the Codex turn", async () => {
  let sawAbort = false;
  const waitForAbort = (options: TurnOptions | undefined) =>
    new Promise<never>((_, reject) => {
      const signal = options?.signal;
      if (signal === undefined) return reject(new Error("the turn has no abort signal"));
      signal.addEventListener("abort", () => {
        sawAbort = true;
        reject(new Error("The operation was aborted"));
      });
    });
  const fake = await reviewer([waitForAbort]);
  const session = await run(fake.reviewer.startPhase);
  const reached = fake.sdk.nextCall();
  const fiber = Effect.runFork(session.review("review the plan"));
  await reached;
  await sleep(10);
  await run(Fiber.interrupt(fiber));
  assert.equal(sawAbort, true, "the Codex turn was not aborted");
});
