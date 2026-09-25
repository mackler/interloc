import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import type { TurnOptions } from "@openai/codex-sdk";
import { Effect, Fiber, Layer } from "effect";
import { makeCodexReviewer } from "../src/codex.ts";
import type { RunError } from "../src/errors.ts";
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

test("newPhase starts a thread with danger-full-access, approval never, the project as working directory", async () => {
  const fake = await reviewer([]);
  await run(fake.reviewer.newPhase);
  assert.equal(fake.sdk.threads.length, 1);
  assert.deepEqual(fake.sdk.threads[0].options, {
    workingDirectory: fake.project,
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
  });
});

test("the configured model is passed, and no model key is set when codexModel is null", async () => {
  const withModel = await reviewer([], { codexModel: "gpt-x" });
  await run(withModel.reviewer.newPhase);
  assert.equal(withModel.sdk.threads[0].options?.model, "gpt-x");

  const without = await reviewer([]);
  await run(without.reviewer.newPhase);
  assert.ok(!("model" in (without.sdk.threads[0].options ?? {})), "model must be absent when codexModel is null");
});

test("review passes agentJsonSchema(Review) as outputSchema and records usage", async () => {
  const fake = await reviewer([turn(JSON.stringify({ issues: [{ id: "A", severity: "major", location: "l", problem: "p", evidence: "e" }] }))]);
  await run(fake.reviewer.newPhase);
  const text = await run(fake.reviewer.review("review the plan"));

  assert.deepEqual(JSON.parse(text).issues.map((i: { id: string }) => i.id), ["A"]);
  assert.deepEqual(fake.sdk.threads[0].calls[0].turnOptions?.outputSchema, agentJsonSchema(S.Review));
  assert.equal(fake.sdk.threads[0].calls[0].input, "review the plan");
  const usage = JSON.parse(fs.readFileSync(path.join(fake.dir, "usage.jsonl"), "utf8").trim());
  assert.equal(usage.agent, "codex");
  assert.equal(usage.thread_id, "thread-1");
  assert.deepEqual(usage.usage, { input_tokens: 10, output_tokens: 5 });
});

test("a failed turn fails with CodexCallFailed", async () => {
  const fake = await reviewer([new Error("the model is overloaded")]);
  await run(fake.reviewer.newPhase);
  await assert.rejects(run(fake.reviewer.review("review the plan")), (e: unknown) => tag(e) === "CodexCallFailed");
});

test("the reviewer returns a reply without an issues array unchanged to the caller", async () => {
  const fake = await reviewer([turn(JSON.stringify({ findings: [] }))]);
  await run(fake.reviewer.newPhase);
  assert.equal(await run(fake.reviewer.review("review the plan")), JSON.stringify({ findings: [] }));
});

test("each newPhase starts a new thread", async () => {
  const empty = JSON.stringify({ issues: [] });
  const fake = await reviewer([turn(empty), turn(empty)]);
  await run(fake.reviewer.newPhase);
  await run(fake.reviewer.review("first phase"));
  await run(fake.reviewer.newPhase);
  await run(fake.reviewer.review("second phase"));

  assert.equal(fake.sdk.threads.length, 2);
  assert.deepEqual(fake.sdk.threads.map((t) => t.calls.length), [1, 1]);
});

test("review before newPhase fails", async () => {
  const fake = await reviewer([]);
  await assert.rejects(run(fake.reviewer.review("review the plan")));
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
  await run(fake.reviewer.newPhase);
  const fiber = Effect.runFork(fake.reviewer.review("review the plan"));
  while ((fake.sdk.threads[0]?.calls.length ?? 0) === 0) await sleep(5);
  await sleep(10);
  await run(Fiber.interrupt(fiber));
  assert.equal(sawAbort, true, "the Codex turn was not aborted");
});
