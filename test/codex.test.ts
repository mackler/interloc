import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { CodexReviewer } from "../src/codex.ts";
import type { RunError } from "../src/errors.ts";
import { reviewSchema } from "../src/schemas.ts";
import { State } from "../src/state.ts";
import { defaultConfig, type Config } from "../src/types.ts";
import { FakeSdk, turn } from "./fakeSdk.ts";
import { tempRepo } from "./helpers.ts";
import type { RunResult } from "@openai/codex-sdk";

const reviewer = (turns: (RunResult | Error)[], config: Partial<Config> = {}): { reviewer: CodexReviewer; sdk: FakeSdk; state: State } => {
  const state = new State(tempRepo());
  state.init("task");
  const sdk = new FakeSdk([], turns);
  return { reviewer: new CodexReviewer(state, { ...defaultConfig, ...config }, sdk), sdk, state };
};

const tag = (e: unknown): string => (e as RunError)._tag;

test("newPhase starts a thread with danger-full-access, approval never, the project as working directory", () => {
  const fake = reviewer([]);
  fake.reviewer.newPhase();
  assert.equal(fake.sdk.threads.length, 1);
  assert.deepEqual(fake.sdk.threads[0].options, {
    workingDirectory: fake.state.project,
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
  });
});

test("the configured model is passed, and no model key is set when codexModel is null", () => {
  const withModel = reviewer([], { codexModel: "gpt-x" });
  withModel.reviewer.newPhase();
  assert.equal(withModel.sdk.threads[0].options?.model, "gpt-x");

  const without = reviewer([]);
  without.reviewer.newPhase();
  assert.ok(!("model" in (without.sdk.threads[0].options ?? {})), "model must be absent when codexModel is null");
});

test("review passes the review JSON Schema as outputSchema and records usage", async () => {
  const fake = reviewer([turn(JSON.stringify({ issues: [{ id: "A", severity: "major", location: "l", problem: "p", evidence: "e" }] }))]);
  fake.reviewer.newPhase();
  const review = await fake.reviewer.review("review the plan");

  assert.deepEqual(review.issues.map((i) => i.id), ["A"]);
  assert.deepEqual(fake.sdk.threads[0].calls[0].turnOptions?.outputSchema, reviewSchema);
  assert.equal(fake.sdk.threads[0].calls[0].input, "review the plan");
  const usage = JSON.parse(fs.readFileSync(path.join(fake.state.dir, "usage.jsonl"), "utf8").trim());
  assert.equal(usage.agent, "codex");
  assert.equal(usage.thread_id, "thread-1");
  assert.deepEqual(usage.usage, { input_tokens: 10, output_tokens: 5 });
});

test("a failed turn fails with CodexCallFailed", async () => {
  const fake = reviewer([new Error("the model is overloaded")]);
  fake.reviewer.newPhase();
  await assert.rejects(fake.reviewer.review("review the plan"), (e: unknown) => tag(e) === "CodexCallFailed");
});

test("a reply without an issues array fails with CodexCallFailed", async () => {
  const fake = reviewer([turn(JSON.stringify({ findings: [] }))]);
  fake.reviewer.newPhase();
  await assert.rejects(fake.reviewer.review("review the plan"), (e: unknown) => tag(e) === "CodexCallFailed");
});

test("each newPhase starts a new thread", async () => {
  const empty = JSON.stringify({ issues: [] });
  const fake = reviewer([turn(empty), turn(empty)]);
  fake.reviewer.newPhase();
  await fake.reviewer.review("first phase");
  fake.reviewer.newPhase();
  await fake.reviewer.review("second phase");

  assert.equal(fake.sdk.threads.length, 2);
  assert.deepEqual(fake.sdk.threads.map((t) => t.calls.length), [1, 1]);
});

test("review before newPhase fails", async () => {
  const fake = reviewer([]);
  await assert.rejects(fake.reviewer.review("review the plan"));
});
