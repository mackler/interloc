// S1: one statement of the rules for a question put to the user. The prompt that asks an agent for a question and the
// review that approves one are both rendered from QUESTION_RULES, so that they cannot disagree (rules for changes: the seam).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as prompts from "../src/prompts.ts";

const RULE_IDS = ["selfContained", "nameThings", "noIdentifiers", "noLiterals", "kindBeforeNumber", "oneWord", "noInternalTerms", "questionLast", "context", "determinateOptions", "terms"];

test("QUESTION_RULES holds one entry per rule, with unique ids and a rule and a criterion each", () => {
  assert.deepEqual(prompts.QUESTION_RULES.map((r) => r.id), RULE_IDS);
  for (const r of prompts.QUESTION_RULES) {
    assert.ok(r.rule.trim().length > 0, r.id);
    assert.ok(r.criterion.trim().length > 0, r.id);
  }
});

test("the writer's rendering carries every rule, and the reviewer's every criterion, from the one array", () => {
  const writing = prompts.questionWritingRules();
  const review = prompts.questionReviewCriteria();
  for (const r of prompts.QUESTION_RULES) {
    assert.ok(writing.includes(r.rule), `the writing rules lack ${r.id}`);
    assert.ok(review.includes(r.criterion), `the review criteria lack ${r.id}`);
  }
});

test("the context rule names the five points, in the words the reviewer checks", () => {
  const context = prompts.QUESTION_RULES.find((r) => r.id === "context")!;
  for (const text of [context.rule, context.criterion]) {
    for (const point of [/one to three words/, /what each does/, /where in the application/, /when, during the operation of the program/, /purpose .* in computing terms and in human terms/]) assert.match(text, point, context.id);
  }
});

test("every prompt that may return questions_for_user carries the writer's rendering", () => {
  const texts = [
    prompts.planRespondPrompt(1, 1),
    prompts.requirementsRespondPrompt(1),
    prompts.questionRespondPrompt(1),
    prompts.decisionRespondPrompt(1, 1),
    prompts.workRespondPrompt(1, 1, { review: { issues: [] }, log: [], changes: null }),
    prompts.initialPlanPrompt("t", false),
    prompts.revisePlanPrompt,
    prompts.revisePlanAfterExecutionPrompt(1, { stopped: false, workReview: "converged" }),
  ];
  for (const text of texts) assert.ok(text.includes(prompts.questionWritingRules()), text.slice(0, 80));
});
