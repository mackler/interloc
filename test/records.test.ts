import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Result, Schema } from "effect";
import { describe, type StateFileInvalid } from "../src/errors.ts";
import { convertPlanReviewDir, LogFile, readLog, readQuestions, readRound, readUsage, RoundFile, type RoundRecord } from "../src/records.ts";
import * as S from "../src/schema.ts";
import { type Platform, platformLayer } from "../src/store.ts";
import { tempDir } from "./helpers.ts";

// Decision Q5 and its follow-up: tagged version-2 records, readers that accept version 1 as well, and a
// converter for archives. The fixture is a reduced copy of a real version-1 run of this repository.
const FIXTURE = path.join(import.meta.dirname, "fixtures", "run-v1");
const read = (...parts: string[]): string => fs.readFileSync(path.join(...parts), "utf8");
const run = <A, E>(effect: Effect.Effect<A, E, Platform>): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(platformLayer)));
const ok = <A, E>(result: Result.Result<A, E>): A => {
  assert.ok(Result.isSuccess(result), `failed: ${Result.isFailure(result) ? describe(result.failure as never) : ""}`);
  return result.success;
};
const failureText = <A>(result: Result.Result<A, StateFileInvalid>): string => {
  assert.ok(Result.isFailure(result), "the read succeeded");
  return describe(result.failure);
};
/** A writable copy of the fixture. */
const copyOfFixture = (): string => {
  const dir = tempDir("run-v1-");
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
};
/** Every file of a directory with its bytes. */
const bytesOf = (dir: string): Map<string, string> => {
  const out = new Map<string, string>();
  const walk = (sub: string): void => {
    for (const name of fs.readdirSync(path.join(dir, sub)).sort()) {
      const rel = path.join(sub, name);
      if (fs.statSync(path.join(dir, rel)).isDirectory()) walk(rel);
      else out.set(rel, read(dir, rel));
    }
  };
  walk("");
  return out;
};

test("a version-1 log file reads to the same entries as its version-2 form", () => {
  const entries = ok(readLog("issue-log.json", read(FIXTURE, "issue-log.json")));
  assert.equal(entries.length, 6);
  const first = entries[0];
  assert.equal(first.source, "review");
  assert.equal(first.superseded, false, "superseded is required in version 2");
  assert.equal(first.duplicate_of, null, "an absent reference is null in version 2");
  const self = entries[5];
  assert.equal(self.source, "self_correction");
  assert.equal(self.action, "plan_error");
  assert.deepEqual(ok(readLog("issue-log.json", JSON.stringify({ version: 2, entries }))), entries);
});

test("a version-2 review entry with a misspelled action fails naming the path (finding 6)", () => {
  const entry = { id: "A", phase: 1, round: 1, source: "review", severity: "major", location: "l", problem: "p", evidence: "e", action: "accpeted", rationale: "r", duplicate_of: null, reverses: null, superseded: false };
  assert.match(failureText(readLog("issue-log.json", JSON.stringify({ version: 2, entries: [entry] }))), /issue-log\.json could not be read: .*entries\[0\]\.action/);
});

test("a version-2 user entry with a severity, and a review entry without one, fail", () => {
  const user = { id: "A", phase: 1, round: 1, source: "user", problem: "p", action: "decided_by_user", rationale: "r", superseded: false, severity: "major" };
  assert.match(failureText(readLog("l.json", JSON.stringify({ version: 2, entries: [user] }))), /entries\[0\]/);
  const review = { id: "A", phase: 1, round: 1, source: "review", location: "l", problem: "p", evidence: "e", action: "accepted", rationale: "r", duplicate_of: null, reverses: null, superseded: false };
  assert.match(failureText(readLog("l.json", JSON.stringify({ version: 2, entries: [review] }))), /entries\[0\]\.severity/);
});

test("a version-1 entry whose action is not one of its source's actions fails on read", () => {
  const v1 = [{ id: "A", phase: 1, round: 1, source: "review", severity: "major", location: "l", problem: "p", evidence: "e", action: "accpeted", rationale: "r" }];
  assert.match(failureText(readLog("issue-log.json", JSON.stringify(v1))), /issue-log\.json could not be read: .*\[0\]\.action/);
});

test("usage lines of both versions read to version-2 records", () => {
  const records = ok(readUsage("usage.jsonl", read(FIXTURE, "usage.jsonl")));
  assert.equal(records.length, 6);
  assert.deepEqual(records[0], { version: 2, agent: "claude", time: "2026-09-21T22:44:31.660Z", session: "fb1a9a64-a690-4d1b-adbe-046314de7640", num_turns: 12, total_cost_usd: 1.078743 });
  assert.deepEqual(records[1], { version: 2, agent: "codex", time: "2026-09-21T22:45:15.913Z", thread: "01a0c624-7833-7631-b7a2-c12c35642a74", input_tokens: 139089, output_tokens: 929 });
  assert.deepEqual(ok(readUsage("usage.jsonl", records.map((r) => JSON.stringify(r)).join("\n") + "\n")), records);
});

test("questions.json of both versions reads to the version-2 file", () => {
  const file = ok(readQuestions("questions.json", read(FIXTURE, "questions.json")));
  assert.equal(file.version, 2);
  assert.equal(file.questions.length, 8);
  assert.deepEqual(ok(readQuestions("questions.json", JSON.stringify(file))), file);
});

test("readRound reconstructs a version-1 round against its pre-round history: the archive's generated self-correction id", async () => {
  const record = await run(readRound(FIXTURE, "planning-4", 1));
  assert.equal(record.kind, "validated", JSON.stringify(record).slice(0, 300));
  if (record.kind !== "validated") return;
  assert.equal(record.reconstructed, true);
  assert.deepEqual([record.subject, record.phase, record.round], ["planning-4", 4, 1]);
  assert.deepEqual(record.review.issues.map((i) => i.id), ["P4-R1-1"]);
  assert.deepEqual(record.response.selfCorrections.map((s) => [s.id, s.generated]), [["P4-S1-1", true]]);
  assert.deepEqual(record.response.dispositions.map((d) => [d.id, d.action, d.duplicateOf, d.reverses]), [["P4-R1-1", "accepted", null, null]]);
});

test("readRound gives no_response for a converged round and for an interrupted round", async () => {
  const converged = await run(readRound(FIXTURE, "planning-1", 2));
  assert.equal(converged.kind, "no_response");
  assert.deepEqual(converged.review.issues, []);
  const interrupted = await run(readRound(FIXTURE, "planning-4", 2));
  assert.equal(interrupted.kind, "no_response");
  assert.deepEqual(interrupted.review.issues.map((i) => i.id), ["P4-R2-1"]);
});

test("readRound gives invalid with the problems for a pair that does not validate", async () => {
  const dir = copyOfFixture();
  const cc = path.join(dir, "planning-1", "cc-1.json");
  const response = JSON.parse(read(cc));
  response.dispositions.push({ ...response.dispositions[0] });
  fs.writeFileSync(cc, JSON.stringify(response));
  const record = await run(readRound(dir, "planning-1", 1));
  assert.equal(record.kind, "invalid");
  if (record.kind !== "invalid") return;
  assert.equal(record.reconstructed, true);
  assert.deepEqual(record.problems.duplicateDispositions, ["P1-R1-1"]);
  assert.equal(record.response?.dispositions.length, 5);
});

test("convertPlanReviewDir rewrites a copy of the fixture to version 2, idempotently, leaving the agents' replies untouched", async () => {
  const dir = copyOfFixture();
  const before = bytesOf(dir);
  const first = await run(convertPlanReviewDir(dir));
  assert.ok(first.written.length > 0, "nothing was written");

  const strict = <T>(schema: Schema.Decoder<T>, text: string): T => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(JSON.parse(text));
  for (const name of ["issue-log.json", "questions-log.json", "requirements-log.json"]) strict(LogFile, read(dir, name));
  for (const line of read(dir, "usage.jsonl").trim().split("\n")) strict(S.UsageRecord, line);
  assert.equal(strict(S.QuestionsFile, read(dir, "questions.json")).version, 2);
  const kinds: Record<string, RoundRecord["kind"]> = {};
  for (const [subject, n] of [["planning-1", 1], ["planning-1", 2], ["planning-4", 1], ["planning-4", 2], ["question-review", 1], ["question-review", 2], ["requirements-review", 1]] as const) {
    const record = strict(RoundFile, read(dir, subject, `round-${n}.json`));
    assert.equal(record.reconstructed, true);
    kinds[`${subject}/${n}`] = record.kind;
  }
  assert.deepEqual(kinds, {
    "planning-1/1": "validated", "planning-1/2": "no_response", "planning-4/1": "validated", "planning-4/2": "no_response",
    "question-review/1": "validated", "question-review/2": "no_response", "requirements-review/1": "no_response",
  });
  const converted = await run(readRound(dir, "planning-4", 1));
  assert.equal(converted.kind, "validated");

  const after = bytesOf(dir);
  for (const [rel, bytes] of before) {
    if (/(^|\/)(review|cc)-\d+\.json$/.test(rel) || rel.startsWith("execution-")) assert.equal(after.get(rel), bytes, `${rel} changed`);
  }
  const second = await run(convertPlanReviewDir(dir));
  assert.deepEqual(second.written, []);
  assert.deepEqual(bytesOf(dir), after);
});
