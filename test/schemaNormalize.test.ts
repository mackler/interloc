import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { describe } from "../src/errors.ts";
import { normalizeQuestionList, normalizeReport, normalizeTurn } from "../src/schemaNormalize.ts";

// Finding 8 / decision Q4: the wire shapes become variants after decoding.
const turn = (complete: boolean, summary: string) => ({ message_to_user: "m", answered_ids: [], complete, summary });

test("normalizeTurn: a summary is proposed only when complete is true and the summary is not blank", () => {
  assert.deepEqual(normalizeTurn(turn(true, "# Requirements")), { kind: "summary_proposed", message: "m", summary: "# Requirements" });
  assert.deepEqual(normalizeTurn(turn(true, "   \n")), { kind: "continuing", message: "m" });
  assert.deepEqual(normalizeTurn(turn(false, "# Requirements")), { kind: "continuing", message: "m" });
  assert.deepEqual(normalizeTurn(turn(false, "")), { kind: "continuing", message: "m" });
});

test("normalizeReport: finished, awaiting input with the question, blocked with the description", () => {
  assert.deepEqual(normalizeReport({ status: "finished", summary: "s", question: "ignored", remaining_work: "" }), { kind: "finished", summary: "s", remainingWork: "" });
  assert.deepEqual(normalizeReport({ status: "needs_input", summary: "s", question: "A or B?", remaining_work: "w" }), { kind: "awaiting_input", question: "A or B?", summary: "s", remainingWork: "w" });
  assert.deepEqual(normalizeReport({ status: "blocked", summary: "s", question: "no network", remaining_work: "w" }), { kind: "blocked", description: "no network", summary: "s", remainingWork: "w" });
});

const q = (id: string, defaultAnswer: string) => ({ id, question: "q?", reason: "r", proposed_answers: [{ label: "A", description: "a" }, { label: "B", description: "b" }], default_answer: defaultAnswer });

test("normalizeQuestionList keeps a default that names a proposed answer and nulls one that does not, with a note", () => {
  const result = normalizeQuestionList({ questions: [q("Q1", "A"), q("Q2", "C")] });
  assert.ok(Result.isSuccess(result));
  assert.deepEqual(result.success.questions.map((x) => x.default_answer), ["A", null]);
  assert.equal(result.success.notes.length, 1);
  assert.match(result.success.notes[0], /Q2.*C/);
});

test("normalizeQuestionList fails with QuestionListInvalid for duplicate or empty ids", () => {
  const duplicate = normalizeQuestionList({ questions: [q("Q1", "A"), q("Q1", "B"), q("Q2", "A"), q("Q2", "A")] });
  assert.ok(Result.isFailure(duplicate));
  assert.deepEqual(duplicate.failure.duplicateIds, ["Q1", "Q2"]);
  assert.match(describe(duplicate.failure), /more than one question with the id: Q1, Q2/);
  const empty = normalizeQuestionList({ questions: [q("", "A")] });
  assert.ok(Result.isFailure(empty));
  assert.equal(empty.failure.emptyIds, 1);
});
