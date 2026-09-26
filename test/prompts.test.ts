import assert from "node:assert/strict";
import { test } from "node:test";
import { planReviewPrompt, questionReviewPrompt } from "../src/prompts.ts";
import * as prompts from "../src/prompts.ts";
import { NUMBERED_MESSAGE } from "./interviewFixture.ts";

// Decision Q5: the prompts describe the version-2 issue log (an object with entries; three sources; null references).
test("the log rules name the entries list, the three sources and null references", () => {
  for (const text of [planReviewPrompt(1, 1, false), questionReviewPrompt(1)]) {
    assert.match(text, /'entries'/);
    assert.match(text, /source 'review'/);
    assert.match(text, /source 'self_correction'/);
    assert.match(text, /source 'user'/);
    assert.match(text, /duplicate_of .*null|null .*duplicate_of/);
  }
});

test("the interview prompts prescribe the answer format that the page's numbered choices parse", () => {
  const texts = [prompts.interviewOpenPrompt, prompts.interviewOpenEmptyPrompt("hello"), prompts.interviewGapsPrompt("plan-review/requirements-review/review-1.json", ["G-R1-1"])];
  for (const text of texts) assert.match(text, /show each proposed answer on its own line in the form `<n>\. <answer>`, numbered from 1/);
  // The fixture that the parser test uses is written in that format.
  assert.match(NUMBERED_MESSAGE, /^1\. .+\n2\. .+/m);
});

// Plan step 2.6: the prompts of the work review and the revision of the plan after an execution phase.
test("the work review prompt names the change record, the plan, the requirements, the log and the ids", () => {
  const first = prompts.workReviewPrompt(2, 1, true);
  assert.match(first, /plan-review\/work-review-2\/changes\.diff/);
  assert.match(first, /plan-review\/plan\.md/);
  assert.match(first, /plan-review\/requirements\.md/);
  assert.match(first, /plan-review\/work-review-log\.json/);
  assert.match(first, /W2-R1-1/);
  assert.match(first, /not marked completed .* not yet implemented/);
  assert.doesNotMatch(prompts.workReviewPrompt(2, 1, false), /requirements\.md/);
  const later = prompts.workReviewPrompt(2, 3, true);
  assert.match(later, /W2-R3-1/);
  assert.match(later, /changes\.diff has been rewritten/);
});

test("the work response prompt forbids any file change and defers the corrections", () => {
  const text = prompts.workRespondPrompt(2, 1);
  assert.match(text, /plan-review\/work-review-2\/review-1\.json/);
  assert.match(text, /later execution phase after the plan has been revised/);
  assert.match(text, /Do not modify any file\./);
});

test("the revision prompt after an execution phase names the stop and the work review's outcome", () => {
  const stopOnly = prompts.revisePlanAfterExecutionPrompt(1, { stopped: true, workReview: "converged" });
  assert.match(stopOnly, /^Execution phase 1 has ended\./);
  assert.match(stopOnly, /last entry of plan-review\/user-decisions\.md/);
  assert.match(stopOnly, /Work review 1 found no issue in the work so far/);
  const revise = prompts.revisePlanAfterExecutionPrompt(2, { stopped: false, workReview: { revisedInRound: 3 } });
  assert.doesNotMatch(revise, /last entry of plan-review\/user-decisions\.md contains the user's input for this stop/);
  assert.match(revise, /Work review 2 ended in round 3/);
  assert.match(revise, /plan-review\/work-review-2\/round-3\.json/);
  assert.match(revise, /plan-review\/work-review-log\.json/);
  assert.match(revise, /keep the completed steps and their markers/);
  const both = prompts.revisePlanAfterExecutionPrompt(1, { stopped: true, workReview: { revisedInRound: 1 } });
  assert.match(both, /user's input for this stop/);
  assert.match(both, /Work review 1 ended in round 1/);
});
