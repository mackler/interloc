import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Result } from "effect";
import { describe, type StateFileInvalid } from "../src/errors.ts";
import { platformLayer } from "../src/platform.ts";
import { readCheckpoint, readLog, readQuestions, readUsage } from "../src/records.ts";
import { finished, issue, respond, runTask, tempRepo, testLayer } from "./helpers.ts";

// Decision Q5: tagged version-2 records. Only the current shape is read (the developer removed the old-shape
// readers and the converter on 25 Sep 2026); a file of the old shape is StateFileInvalid.
const ok = <A, E>(result: Result.Result<A, E>): A => {
  assert.ok(Result.isSuccess(result), `failed: ${Result.isFailure(result) ? describe(result.failure as never) : ""}`);
  return result.success;
};
const failureText = <A>(result: Result.Result<A, StateFileInvalid>): string => {
  assert.ok(Result.isFailure(result), "the read succeeded");
  return describe(result.failure);
};
const review = { id: "A", phase: 1, round: 1, source: "review", severity: "major", location: "l", problem: "p", evidence: "e", action: "accepted", rationale: "r", duplicate_of: null, reverses: null, superseded: false };

test("readLog reads a version-2 log file and rejects a bare array (the old shape)", () => {
  const entries = ok(readLog("issue-log.json", JSON.stringify({ version: 2, entries: [review] })));
  assert.deepEqual(entries, [review]);
  const { duplicate_of: _d, reverses: _r, superseded: _s, ...old } = review;
  assert.match(failureText(readLog("issue-log.json", JSON.stringify([old]))), /issue-log\.json could not be read/);
  assert.match(failureText(readLog("issue-log.json", JSON.stringify({ entries: [review] }))), /version/);
});

test("a version-2 review entry with a misspelled action fails naming the path (finding 6)", () => {
  assert.match(failureText(readLog("issue-log.json", JSON.stringify({ version: 2, entries: [{ ...review, action: "accpeted" }] }))), /issue-log\.json could not be read: .*entries\[0\]\.action/);
});

test("a version-2 user entry with a severity, and a review entry without one, fail", () => {
  const user = { id: "A", phase: 1, round: 1, source: "user", problem: "p", action: "decided_by_user", rationale: "r", superseded: false, severity: "major" };
  assert.match(failureText(readLog("l.json", JSON.stringify({ version: 2, entries: [user] }))), /entries\[0\]/);
  const { severity: _severity, ...noSeverity } = review;
  assert.match(failureText(readLog("l.json", JSON.stringify({ version: 2, entries: [noSeverity] }))), /entries\[0\]\.severity/);
});

test("readUsage reads version-2 lines and rejects a line of the old shape, naming the line", () => {
  const claude = { version: 2, agent: "claude", time: "t", session: "s", num_turns: 12, total_cost_usd: 1.07 };
  const codex = { version: 2, agent: "codex", time: "t", thread: "x", input_tokens: 10, output_tokens: 2 };
  assert.deepEqual(ok(readUsage("usage.jsonl", `${JSON.stringify(claude)}\n${JSON.stringify(codex)}\n`)), [claude, codex]);
  const old = { time: "t", agent: "codex", thread_id: "x", usage: { input_tokens: 10, output_tokens: 2 } };
  assert.match(failureText(readUsage("usage.jsonl", `${JSON.stringify(claude)}\n${JSON.stringify(old)}\n`)), /usage\.jsonl could not be read: line 2/);
});

test("readQuestions reads the version-2 file and rejects one without the version marker", () => {
  const file = { version: 2, task: "t", questions: [{ id: "Q1", question: "q?", reason: "r", proposed_answers: [{ label: "A", description: "a" }], default_answer: null }] };
  assert.deepEqual(ok(readQuestions("questions.json", JSON.stringify(file))), file);
  const { version: _v, ...old } = file;
  assert.match(failureText(readQuestions("questions.json", JSON.stringify(old))), /questions\.json could not be read/);
});

// Q6: the checkpoint reader verifies that the records the checkpoint names exist and decode.
test("readCheckpoint gives null without a file, the checkpoint when its records are complete, and StateFileInvalid otherwise", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: { questions_for_user: [] }, plan: "v1" }, { output: respond([["A", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("A")] }, { issues: [] }],
    execs: [finished],
  });
  await runTask(layer);
  const dir = probe.dir;
  const read = () => Effect.runPromise(readCheckpoint(dir).pipe(Effect.provide(platformLayer)));
  assert.equal((await read())?.stage, "executed");
  const write = (point: Record<string, unknown>) => fs.writeFileSync(path.join(dir, "checkpoint.json"), JSON.stringify({ version: 2, ...point, time: "2026-09-25T12:00:00.000Z" }));
  write({ subject: "planning-1", phase: 1, round: 1, stage: "responded" });
  assert.equal((await read())?.stage, "responded");
  write({ subject: "planning-1", phase: 1, round: 2, stage: "reviewed" });
  assert.equal((await read())?.stage, "reviewed");
  const rejects = async (point: Record<string, unknown>, what: string) => {
    write(point);
    const exit = await Effect.runPromiseExit(readCheckpoint(dir).pipe(Effect.provide(platformLayer)));
    assert.ok(exit._tag === "Failure", `${what}: the checkpoint was accepted`);
  };
  await rejects({ subject: "planning-1", phase: 1, round: 3, stage: "reviewed" }, "a round without a review file");
  await rejects({ subject: "planning-1", phase: 1, round: 2, stage: "responded" }, "a responded stage without a response file");
  await rejects({ subject: "execution", phase: 2, round: 0, stage: "executed" }, "an execution without a result file");
  await rejects({ subject: "planning-1", phase: 1, round: 1, stage: "shipped" }, "an unknown stage");
  fs.rmSync(path.join(dir, "checkpoint.json"));
  assert.equal(await read(), null);
});
