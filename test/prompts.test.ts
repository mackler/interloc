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
  const text = prompts.workRespondPrompt(2, 1, { review: { issues: [] }, log: [], changes: "" });
  assert.match(text, /plan-review\/work-review-2\/review-1\.json/);
  assert.match(text, /later execution phase after the plan has been revised/);
  assert.match(text, /Do not modify any file\./);
});

// Stage A, decision Q1: a read-only work response gets the review, its phase's log entries and the diff in the prompt.
test("the work response prompt carries the review, the log entries of its phase only, and the diff verbatim", () => {
  const review = { issues: [{ id: "W2-R2-1", severity: "major" as const, location: "src/a.ts:3", problem: "the parser drops the last line", evidence: "a.ts reads lines.slice(0, -1)" }] };
  const entry = (phase: number, id: string) => ({ id, phase, round: 1, problem: `problem of ${id}`, rationale: `rationale of ${id}`, superseded: false, source: "review" as const, severity: "minor" as const, location: "x", evidence: "e", action: "rejected" as const, duplicate_of: null, reverses: null });
  const log = [entry(1, "W1-R1-1"), entry(2, "W2-R1-1")] as unknown as Parameters<typeof prompts.workRespondPrompt>[2]["log"];
  const diff = "diff --git a/src/a.ts b/src/a.ts\n+const lines = text.split(\"\\n\");\n";
  const text = prompts.workRespondPrompt(2, 2, { review, log, changes: diff });
  assert.ok(text.includes("the parser drops the last line"), "the review");
  assert.ok(text.includes("rationale of W2-R1-1"), "the phase's log entry");
  assert.ok(!text.includes("W1-R1-1"), "another phase's log entry");
  assert.ok(text.includes(diff), "the diff, verbatim");
  assert.match(text, /Do not modify any file\./);
  assert.match(text, /cannot use any tool/);
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

// W2-R1-4: the page's help and notice texts live here, with the other texts the user reads.
test("the page's hint, notices, progress line and badge", () => {
  assert.equal(prompts.answerHint("line"), "Enter sends.");
  assert.equal(prompts.answerHint("message"), "Enter sends; Shift+Enter starts a new line.");
  assert.equal(prompts.draftWithdrawnNotice("my text"), "This question was answered in another tab; your unsent text was discarded: «my text»");
  assert.equal(prompts.SERVER_CLOSED_NOTICE, "The server has ended. The page reconnects when it is started again.");
  assert.equal(prompts.notSentNotice("answer", "ended"), "Your answer was not sent: the run has ended.");
  assert.equal(prompts.notSentNotice("stop", "ended"), "Stop was not sent: the run has ended.");
  assert.equal(prompts.notSentNotice("answer", "restarted"), "Your answer was not sent: the server has been restarted since.");
  assert.equal(prompts.notSentNotice("stop", "restarted"), "Stop was not sent: the server has been restarted since.");
  assert.equal(prompts.progressLine(null, null), "Progress: no phase has begun");
  assert.equal(prompts.progressLine("Planning 1", null), "Progress: Planning 1");
  assert.equal(prompts.progressLine("Planning 1", { round: 2, limit: 5 }), "Progress: Planning 1, round 2 of 5");
  assert.equal(prompts.unseenBadge(3), "· 3 new");
});

// Defect B of docs/page-question-phase-defects.md: the notices of a frame the page cannot read and of the failed page.
test("the protocol error's notice carries the reason, cut to 200 characters", () => {
  assert.equal(prompts.protocolErrorNotice("Expected no excess property"), "The page could not read a message from the server; reconnecting. Reason: Expected no excess property");
  const long = "x".repeat(500);
  assert.equal(prompts.protocolErrorNotice(long), `The page could not read a message from the server; reconnecting. Reason: ${"x".repeat(200)}…`);
  assert.equal(prompts.protocolErrorNotice("y".repeat(200)), `The page could not read a message from the server; reconnecting. Reason: ${"y".repeat(200)}`);
  assert.match(prompts.CONNECTION_FAILED_NOTICE, /stopped reconnecting/);
  assert.match(prompts.CONNECTION_FAILED_NOTICE, /[Rr]eload the page/);
  assert.equal(prompts.UNSENT_HEADING, "Not sent");
});

test("an action not sent because the page is no longer connected, with the answer's text quoted or in the field", () => {
  assert.equal(prompts.notSentNotice("answer", "disconnected"), "Your answer was not sent: the page is no longer connected to the server. Its text is still in the answer field.");
  assert.equal(prompts.notSentNotice("answer", "disconnected", "my text"), "Your answer was not sent: the page is no longer connected to the server. Its text is kept under “Not sent”: «my text»");
  assert.equal(prompts.notSentNotice("stop", "disconnected"), "Stop was not sent: the page is no longer connected to the server.");
  assert.equal(prompts.notSentNotice("start", "disconnected"), "The new task was not sent: the page is no longer connected to the server.");
  assert.equal(prompts.notSentNotice("list", "disconnected"), "The directory listing was not requested: the page is no longer connected to the server.");
});
