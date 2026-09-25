import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDecision, renderFeedback, renderQuestions, renderRound, subjectHeading } from "../src/render.ts";
import { issue, respond } from "./helpers.ts";

// Finding 27 / recommendation D: the Store writes; the text of the records is composed here.
test("subject headings", () => {
  assert.deepEqual([subjectHeading("questions"), subjectHeading("requirements"), subjectHeading({ plan: 3 })], ["Question review", "Requirements review", "Planning phase 3"]);
});

test("renderRound lists the issues, the dispositions with their references, the self-corrections and the feedback", () => {
  const review = { issues: [issue("A"), issue("B")] };
  const base = respond([["A", "accepted"], ["B", "rejected"]]);
  const response = {
    ...base,
    dispositions: base.dispositions.map((d) => (d.id === "B" ? { ...d, duplicate_of: "A" } : d)),
    self_corrections: [{ id: "C", new_action: "plan_error" as const, explanation: "oops" }],
    reviewer_feedback: "be brief",
  };
  const text = renderRound("Planning phase 1", 2, review, response);
  assert.match(text, /^## Planning phase 1, round 2\n\n### Codex\n\n- \*\*\[A\]\*\* /);
  assert.match(text, /### Claude Code\n\n- \*\*\[A\]\*\* accepted: rationale A\n- \*\*\[B\]\*\* rejected \(duplicate of A\): rationale B\n- \*\*Self-correction\*\* \(plan_error, issue "C"\): oops\n- \*\*Feedback to the reviewer:\*\* be brief\n\n$/);
});

test("renderDecision gives the record line and the conversation line of one decision event", () => {
  const lines = renderDecision({ subject: "issue A, raised again", id: null, decision: "keep it", phase: 1, round: 2 });
  assert.equal(lines.record, "Subject: issue A, raised again\nDecision: keep it\n\n");
  assert.equal(lines.conversation, "**User decision** on issue A, raised again: keep it\n\n");
});

test("renderFeedback and renderQuestions", () => {
  assert.equal(renderFeedback("Planning phase 1", 2, "too strict"), "## Planning phase 1, round 2\ntoo strict\n\n");
  assert.equal(renderQuestions({ questions: [] }), "The list is empty.\n");
  const list = { questions: [{ id: "Q1", question: "A or B?", reason: "r", proposed_answers: [{ label: "A", description: "a" }, { label: "B", description: "b" }], default_answer: "B" }] };
  assert.equal(renderQuestions(list), "- **[Q1]** A or B?\n  Reason: r\n  - A: a\n  - B: b (default)\n");
  assert.match(renderQuestions({ questions: [{ ...list.questions[0], default_answer: null }] }), /- B: b\n$/);
});
