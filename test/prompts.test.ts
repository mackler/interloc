import assert from "node:assert/strict";
import { test } from "node:test";
import { planReviewPrompt, questionReviewPrompt } from "../src/prompts.ts";

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
