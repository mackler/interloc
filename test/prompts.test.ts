import assert from "node:assert/strict";
import * as fs from "node:fs";
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
  assert.equal(prompts.progressLine("Planning 1", "cycle 2"), "Progress: Planning 1, cycle 2");
  assert.equal(prompts.progressLine("Gather Requirements — Clarification", "3 of 7 answered"), "Progress: Gather Requirements — Clarification, 3 of 7 answered");
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

// Issue #14: the user reads "cycle", never "round", at the limit; the agents' prompts and the records keep "round".
test("the cycle limit's prompts, in the terminal and in the page, speak of cycles", () => {
  const limit = prompts.limitPrompt(5, "proceed to implementation with the plan as it is");
  assert.equal(limit, "5 cycles completed without convergence. Number = additional cycles; p = proceed to implementation with the plan as it is; 0 = stop > ");
  assert.equal(prompts.limitNoProceedPrompt(2), "2 cycles completed without convergence. Number = additional cycles; 0 = stop > ");
  assert.equal(prompts.pagePromptText("limit", limit), "5 cycles completed without convergence. Add cycles, proceed without convergence, or stop.");
  assert.equal(prompts.pagePromptText("limitNoProceed", prompts.limitNoProceedPrompt(2)), "2 cycles completed without convergence. Add cycles or stop.");
});

test("the status lines of the phases name Gather Requirements and Implementation", () => {
  assert.equal(prompts.questionListLine, "Gather Requirements: Claude Code formulates the question list ...");
  assert.equal(prompts.implementationBeganLine(2, "auto"), "\nImplementation phase 2: Claude Code implements the plan (permission mode auto) ...");
  assert.equal(prompts.implementationEndedLine(2, "finished"), "\nImplementation phase 2 ended with status: finished");
  assert.equal(prompts.taskFinishedLine(3), "\nClaude Code reports that the task is finished after 3 implementation phase(s).");
  assert.equal(prompts.IMPLEMENTATION_STOPPED_LINE, "\nClaude Code has stopped implementation with a question.");
});

// The Q5 follow-up of issue #21: the user reads "clarification" where the records say "interview".
test("the clarification's headings and help", () => {
  assert.equal(prompts.clarificationHeading("clarification"), "Clarification");
  assert.equal(prompts.clarificationHeading("followUp"), "Follow-up clarification");
  assert.equal(prompts.clarificationHeading("conversation"), "Conversation before planning");
  assert.equal(prompts.interviewHelp("Clarification", "page"), "Clarification. /done ends the clarification, /quit ends the run; Shift+Enter starts a new line.");
  assert.equal(prompts.interviewHelp("Clarification", "terminal"), '\nClarification. Commands: /done = end the clarification; /quit = end the run; """ on its own line starts and ends a message of several lines.');
  assert.equal(prompts.END_CLARIFICATION, "End clarification");
});

// Issue #14 (Q1, Q2, G-R1-1): a cycle's line and a finished loop's line; no limit anywhere.
test("the cycle lines and the finished loop's line", () => {
  assert.equal(prompts.cycleLine(2, null, null), "cycle 2");
  assert.equal(prompts.cycleLine(2, 3, 3), "cycle 2: 3 issues");
  assert.equal(prompts.cycleLine(1, 1, 1), "cycle 1: 1 issue");
  assert.equal(prompts.cycleLine(3, 0, 0), "cycle 3: 0 issues");
  assert.equal(prompts.cycleLine(2, 3, 1), "cycle 2: 3 issues (1 counted)");
  assert.equal(prompts.loopSummary(2, 3, "converged"), "2 cycles resolved 3 issues");
  assert.equal(prompts.loopSummary(1, 1, "converged"), "1 cycle resolved 1 issue");
  assert.equal(prompts.loopSummary(5, 4, "proceed"), "5 cycles resolved 4 issues, proceeded without convergence");
  assert.equal(prompts.loopSummary(1, 0, "revise"), "1 cycle: 0 corrections due");
  assert.equal(prompts.loopSummary(2, 1, "revise"), "2 cycles: 1 correction due");
});

// Issue #21 (Q6 follow-up): Claude reports every question asked, follow-ups with ids of their own, and the answered ones.
test("the interview rules define asked_ids with follow-up ids, and answered_ids over both", () => {
  for (const text of [prompts.interviewOpenPrompt, prompts.interviewOpenEmptyPrompt("hi"), prompts.interviewGapsPrompt("plan-review/requirements-review/review-1.json", ["G-R1-1"])]) {
    assert.match(text, /asked_ids: the ids of every question you have asked so far: the agreed questions you have asked, and an id F1, F2, … that you assign to each follow-up question/);
    assert.match(text, /answered_ids: the ids of the questions, agreed or follow-up, that the user has answered so far/);
  }
  assert.match(prompts.interviewGapsPrompt("r.json", ["G-R1-1"]), /use the issue ids in asked_ids and answered_ids/);
});

// W1-R1-1: the error texts the user reads at a halt are in src/prompts.ts too.
test("the texts of an invalid cycle and of the stop at the cycle limit", () => {
  assert.equal(prompts.cycleInvalidText(["a", "b"]), "the cycle is invalid: a; b");
  assert.equal(prompts.cycleLimitStopText("Planning phase 1"), "stopped by the user at the cycle limit of Planning phase 1");
});

// Decision Q1 of the decision-support task: every prompt that may put a question to the user says how to fill its options.
test("every prompt that may return questions_for_user says how to fill a question's options", () => {
  const texts = [
    prompts.planRespondPrompt(1, 1),
    prompts.requirementsRespondPrompt(1),
    prompts.questionRespondPrompt(1),
    prompts.workRespondPrompt(1, 1, { review: { issues: [] }, log: [], changes: null }),
    prompts.initialPlanPrompt("t", false),
    prompts.revisePlanPrompt,
    prompts.revisePlanAfterExecutionPrompt(1, { stopped: false, workReview: "converged" }),
  ];
  for (const text of texts) {
    assert.ok(text.includes(prompts.QUESTION_OPTIONS_RULE), text.slice(0, 80));
    assert.match(prompts.QUESTION_OPTIONS_RULE, /two or more mutually exclusive options/);
    assert.match(prompts.QUESTION_OPTIONS_RULE, /empty options array/);
  }
});

// Decision support, plan step 2.2 (D7): the prompts carry docs/decision-making.md verbatim.
const FORMAT = fs.readFileSync(new URL("../docs/decision-making.md", import.meta.url), "utf8");
const decisionQuestion = { phase: { kind: "planning" as const, n: 2 }, question: "Which database?", options: [{ label: "SQLite", description: "one file" }, { label: "PostgreSQL", description: "a server" }] };

test("the analysis prompt carries the format byte for byte, the binding sentence, the question, the options in order and the context", () => {
  const text = prompts.decisionAnalysisPrompt(FORMAT, decisionQuestion, { task: "Build it.", requirements: "# R\nreq text", plan: null });
  assert.ok(text.includes(FORMAT), "the format is not in the prompt verbatim");
  assert.ok(text.includes(prompts.DECISION_FORMAT_AUTHORITY));
  assert.match(prompts.DECISION_FORMAT_AUTHORITY, /authority for the content and layout/);
  assert.ok(text.indexOf("SQLite") < text.indexOf("PostgreSQL"), "the options are not in the question's order");
  assert.match(text, /Which database\?/);
  assert.match(text, /Build it\./);
  assert.match(text, /req text/);
  assert.match(text, /plan-review\/plan\.md does not exist yet/);
  assert.match(text, /Planning 2/);
  assert.match(text, /equivalent_to/);
  assert.match(text, /Disadvantages:/);
});

test("the decision review prompt carries the format in its first round, names the analysis and the question, and the ids D<k>-R<n>-<i>", () => {
  const first = prompts.decisionReviewPrompt(FORMAT, 3, 1);
  assert.ok(first.includes(FORMAT), "the format is not in the first review prompt verbatim");
  assert.match(first, /plan-review\/decision-3\/analysis\.json/);
  assert.match(first, /plan-review\/decision-3\/question\.json/);
  assert.match(first, /D3-R1-1/);
  assert.match(first, /recommendation/);
  assert.match(first, /ids begin with D3-/);
  const later = prompts.decisionReviewPrompt(FORMAT, 3, 2);
  assert.match(later, /D3-R2-1/);
  assert.match(later, /plan-review\/decision-3\/analysis\.json/);
});

test("the decision respond and apply-decisions prompts ask for the complete analysis and forbid file changes", () => {
  const respond = prompts.decisionRespondPrompt(3, 2);
  assert.match(respond, /plan-review\/decision-3\/review-2\.json/);
  assert.match(respond, /complete analysis/);
  assert.match(respond, /Do not modify any file/);
  const apply = prompts.decisionApplyDecisionsPrompt(3);
  assert.match(apply, /user-decisions\.md/);
  assert.match(apply, /complete analysis/);
});

// Issue #25, one line: only the first word of a button label is capitalized, and the terminal's offer line names the
// button's label, built from the same constant.
test("the offer's label reads Help me decide, and the terminal's offer line carries that label", () => {
  assert.equal(prompts.HELP_ME_DECIDE, "Help me decide");
  assert.ok(prompts.OFFER_LINE.includes(`/decide = ${prompts.HELP_ME_DECIDE}:`), prompts.OFFER_LINE);
});
