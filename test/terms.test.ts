// S17 (issue #36, decisions Q8 and "Decided 28 Sep 2026"): after the question review converges, a fresh Claude Code
// session writes the explanations of the agreed questions' terms, and Codex reviews them in a loop of their own,
// under behaviours 5, 6, 7 and 10, before the clarification begins.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import * as prompts from "../src/prompts.ts";
import type * as S from "../src/schema.ts";
import { finished, issue, respond, runFails, runTask, tempRepo, testLayer } from "./helpers.ts";

const noQuestions = { questions_for_user: [] };
const entry: S.QuestionEntry = {
  id: "Q1",
  context: "Claude Code, the coding agent, checks the input of a tool with zod, a library, when the tool is called.",
  question: "Should zod be declared as a dependency?",
  reason: "package.json does not list it",
  proposed_answers: [{ label: "Declare it", description: "add zod to package.json" }, { label: "Leave it", description: "keep it the SDK's" }],
  default_answer: "Declare it",
};
const zod = { term: "zod", explanation: "A library that checks that data has the shape a program expects." };
const terms = (explanation = zod.explanation) => ({ entries: [{ id: "Q1", terms: [{ ...zod, explanation }] }] });
const interviewTurns = [
  { output: { message_to_user: "", current_question: { id: "Q1", context: "", text: "", terms: [], options: [] }, asked_ids: ["Q1"], answered_ids: [], complete: false, summary: "" } },
  { output: { message_to_user: "Done.", current_question: { id: "", context: "", text: "", terms: [], options: [] }, asked_ids: ["Q1"], answered_ids: ["Q1"], complete: true, summary: "# Requirements\n\nQ1: declare it" } },
];
const read = (dir: string, name: string) => fs.readFileSync(path.join(dir, name), "utf8");

test("the terms are written in a fresh session after the question review converges, reviewed, and recorded in terms.json", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["1", ""],
    steps: [{ output: { questions: [entry] } }, ...interviewTurns, { output: noQuestions, plan: "v1" }],
    terms: [{ output: terms() }],
    // The question review, the requirements review, the plan review, the work review; the terms review converges.
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true },
  });
  await runTask(layer);
  assert.deepEqual(JSON.parse(read(probe.dir, "terms.json")), { version: 2, entries: terms().entries });
  assert.equal(probe.planner.termsPrompts[0], prompts.termsPrompt("task"));
  assert.ok(probe.planner.termsPrompts[0].includes(prompts.questionWritingRules()));
  assert.ok(probe.reviewer.prompts.some((p) => p === prompts.termsReviewPrompt(1)));
  assert.ok(prompts.termsReviewPrompt(1).includes(prompts.questionReviewCriteria()));
  assert.ok(fs.existsSync(path.join(probe.dir, "terms-review", "review-1.json")));
  assert.deepEqual(JSON.parse(read(probe.dir, "terms-log.json")), { version: 2, entries: [] });
  assert.match(read(probe.dir, "conversation.md"), /## Terms review, round 1/);
  // The fresh sessions: the terms' own (the question list's session is the run's).
  assert.ok(probe.planner.freshSessions >= 1);
});

test("an accepted issue about an explanation: the response returns the amended explanations, which are written", async () => {
  const amended = terms("A library that checks data against a declared shape and reports what does not fit.");
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["1", ""],
    steps: [{ output: { questions: [entry] } }, ...interviewTurns, { output: noQuestions, plan: "v1" }],
    terms: [{ output: terms("A library.") }, { output: { ...respond([["T-R1-1", "accepted"]]), ...amended } }],
    termsReviews: [{ issues: [issue("T-R1-1", "The explanation of zod does not say what it does.")] }, { issues: [] }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true },
  });
  await runTask(layer);
  assert.deepEqual(JSON.parse(read(probe.dir, "terms.json")).entries, amended.entries);
  const [logged] = await probe.loadLog("terms");
  assert.deepEqual([logged?.id, logged?.action], ["T-R1-1", "accepted"]);
  assert.equal(JSON.parse(read(probe.dir, "checkpoint.json")).subject === "terms-review" || fs.existsSync(path.join(probe.dir, "terms-review", "round-2.json")), true);
});

test("the explanations are validated: a term that occurs nowhere in its question, or a question not in the list, gets the repair turn", async () => {
  const wrong = { entries: [{ id: "Q9", terms: [zod] }, { id: "Q1", terms: [{ term: "Zod", explanation: "a library" }] }] };
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["1", ""],
    steps: [{ output: { questions: [entry] } }, ...interviewTurns, { output: noQuestions, plan: "v1" }],
    terms: [{ output: wrong }, { output: terms() }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true },
  });
  await runTask(layer);
  assert.equal(
    probe.planner.termsPrompts[1],
    prompts.questionRepairPrompt([
      { where: "Q9", problems: [{ kind: "unknownQuestion", subject: "Q9" }] },
      { where: "Q1", problems: [{ kind: "termAbsent", subject: "Zod" }] },
    ]),
  );
});

test("the terms review at its cycle limit: p proceeds to the clarification with the explanations as they are; 0 halts", async () => {
  const limited = (answer: string) =>
    testLayer(tempRepo(), {
      answers: [answer, "1", ""],
      steps: [{ output: { questions: [entry] } }, ...interviewTurns, { output: noQuestions, plan: "v1" }],
      terms: [{ output: terms("A library.") }, { output: { ...respond([["T-R1-1", "rejected"]]), ...terms("A library.") } }],
      termsReviews: [{ issues: [issue("T-R1-1", "The explanation says too little.")] }],
      reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
      execs: [finished],
      config: { questionPhase: true, maxRounds: 1 },
    });
  const proceeding = limited("p");
  await runTask(proceeding.layer);
  assert.match(read(proceeding.probe.dir, "conversation.md"), new RegExp(`\\*\\*User decision:\\*\\* ${prompts.PROCEED_TO_CLARIFICATION_WITH_TERMS} without convergence`));
  await runFails(limited("0").layer, "RoundLimitStop", /Terms review/);
});

test("an empty agreed list writes no terms and has no terms review", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: [""],
    steps: [{ output: { questions: [] } }, { output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true },
  });
  await runTask(layer);
  assert.equal(fs.existsSync(path.join(probe.dir, "terms-review")), false);
  assert.deepEqual(probe.planner.termsPrompts, []);
});
