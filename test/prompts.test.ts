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
