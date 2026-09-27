import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type * as S from "../src/schema.ts";
import { finished, issue, respond, runTask, tempRepo, testLayer } from "./helpers.ts";

type QuestionEntry = typeof S.QuestionEntry.Type;
type InterviewTurn = typeof S.InterviewTurn.Type;

const noQuestions = { questions_for_user: [] };
const q = (id: string): QuestionEntry => ({
  id,
  question: `question ${id}?`,
  reason: "the codebase does not determine it",
  proposed_answers: [{ label: "A", description: "a" }, { label: "B", description: "b" }],
  default_answer: "A",
});
const turn = (message: string, answered: string[], summary = ""): InterviewTurn => ({
  message_to_user: message,
  asked_ids: answered,
  answered_ids: answered,
  complete: summary !== "",
  summary,
});
const read = (dir: string, name: string): string => fs.readFileSync(path.join(dir, name), "utf8");
const withQuestions = { questionPhase: true };

test("question list is amended in review, the interview runs, the summary is confirmed, and planning follows", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["1", "B, because of X", ""],
    steps: [
      { output: { questions: [q("Q1")] } },                                              // question list
      { output: { ...respond([["Q-R1-1", "accepted"]]), questions: [q("Q1"), q("Q2")] } }, // Codex: Q2 is missing
      { output: turn("Q1: A or B?", []) },                                                // interview
      { output: turn("Q2: A or B?", ["Q1"]) },
      { output: turn("Complete.", ["Q1", "Q2"], "# Requirements\n\nQ1: A\nQ2: B because of X") },
      { output: noQuestions, plan: "v1" },                                                // initial plan
    ],
    reviews: [{ issues: [issue("Q-R1-1", "Q2 is missing")] }, { issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: withQuestions,
  });
  await runTask(layer);

  const questions = JSON.parse(read(probe.dir, "questions.json"));
  assert.equal(questions.version, 2);
  assert.equal(questions.task, "task");
  assert.deepEqual(questions.questions.map((x: QuestionEntry) => x.id), ["Q1", "Q2"]);
  assert.match(read(probe.dir, "requirements.md"), /Q2: B because of X/);
  assert.equal((await probe.loadLog("questions"))[0].action, "accepted");
  assert.equal(probe.reviewer.phases, 4); // question review, requirements review, plan review, work review
  assert.ok(probe.planner.prompts.some((p) => p.includes("User: B, because of X")));
  assert.match(probe.planner.prompts.at(-1) ?? "", /requirements\.md contains the user's confirmed answers/);
  const conversation = read(probe.dir, "conversation.md");
  assert.match(conversation, /## Agreed question list/);
  assert.match(conversation, /\*\*User:\*\* B, because of X/);
  assert.match(conversation, /### Confirmed summary/);
});

test("an empty agreed list offers the conversation; Enter starts planning", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: [""],
    steps: [{ output: { questions: [] } }, { output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: withQuestions,
  });
  await runTask(layer);
  assert.match(probe.ui.asked[0], /no question is needed/);
  assert.match(read(probe.dir, "requirements.md"), /No question was needed/);
  assert.equal(probe.reviewer.phases, 3); // question, plan and work review: no requirements review without a conversation
});

test("an empty agreed list with a first message opens a conversation", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["use the existing logger", ""],
    steps: [{ output: { questions: [] } }, { output: turn("Noted.", [], "# Requirements\n\nUse the existing logger.") }, { output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: withQuestions,
  });
  await runTask(layer);
  assert.ok(probe.planner.prompts[1].includes("use the existing logger"));
  assert.match(read(probe.dir, "requirements.md"), /existing logger/);
});

test("an unconfirmed summary continues the conversation", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["A", "Q1 is B, not A", ""],
    steps: [
      { output: { questions: [q("Q1")] } },
      { output: turn("Q1?", []) },
      { output: turn("Complete.", ["Q1"], "Q1: A") },
      { output: turn("Corrected.", ["Q1"], "Q1: B") },
      { output: noQuestions, plan: "v1" },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: withQuestions,
  });
  await runTask(layer);
  assert.equal(read(probe.dir, "requirements.md"), "Q1: B\n");
  assert.ok(probe.planner.prompts.some((p) => p.startsWith("The user does not confirm the summary")));
});

test("a gap that Claude Code accepts produces a second interview and a revised requirements file", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["A", "", "retries: 3", ""],
    steps: [
      { output: { questions: [q("Q1")] } },
      { output: turn("Q1?", []) },
      { output: turn("Complete.", ["Q1"], "Q1: A") },
      { output: respond([["G-R1-1", "accepted"]]) },                      // requirements review response
      { output: turn("How many retries?", []) },                          // second interview
      { output: turn("Complete.", ["G-R1-1"], "Q1: A\nRetries: 3") },
      { output: noQuestions, plan: "v1" },
    ],
    reviews: [{ issues: [] }, { issues: [issue("G-R1-1", "retry count absent")] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: withQuestions,
  });
  await runTask(layer);
  assert.equal(read(probe.dir, "requirements.md"), "Q1: A\nRetries: 3\n");
  assert.match(read(probe.dir, "conversation.md"), /## Interview\n[\s\S]*## Second interview\n/);
  assert.equal((await probe.loadLog("requirements"))[0].id, "G-R1-1");
  // The user reads "Clarification" and "Follow-up clarification"; conversation.md keeps its record headings.
  const headings = probe.ui.notified.flatMap((e) => (e._tag === "InterviewOpened" || e._tag === "InterviewTurn" ? [e.heading] : []));
  assert.deepEqual([...new Set(headings)], ["Clarification", "Follow-up clarification"]);
  // Issue #21 (Q6, Q7): each clarification opens with its total, the agreed questions or the accepted gaps, and each
  // turn carries the count of answered questions against the total so far.
  const counted = probe.ui.notified.flatMap((e) => (e._tag === "InterviewOpened" ? [`opened ${e.stage} ${e.total}`] : e._tag === "InterviewTurn" ? [`${e.answered} of ${e.total}`] : []));
  assert.deepEqual(counted, ["opened clarification 1", "0 of 1", "1 of 1", "opened followUp 1", "0 of 1", "1 of 1"]);
});

test("/done ends the interview early", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["/done", ""],
    steps: [{ output: { questions: [q("Q1")] } }, { output: turn("Q1?", []) }, { output: turn("Ended.", [], "Open points: Q1 -> default A") }, { output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: withQuestions,
  });
  await runTask(layer);
  assert.ok(probe.planner.prompts.some((p) => p.startsWith("The user ends the interview now")));
  assert.match(read(probe.dir, "requirements.md"), /default A/);
});

// Issue #21 (Q6): a follow-up question raises the total; Claude reports it in asked_ids with an id of its own.
test("a follow-up asked during the clarification raises its total", async () => {
  const withFollowUp = (message: string, asked: string[], answered: string[], summary = ""): InterviewTurn => ({ message_to_user: message, asked_ids: asked, answered_ids: answered, complete: summary !== "", summary });
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["A", "3", ""],
    steps: [
      { output: { questions: [q("Q1"), q("Q2")] } },
      { output: withFollowUp("Q1?", ["Q1"], []) },
      { output: withFollowUp("How many retries? (a follow-up)", ["Q1", "F1"], ["Q1"]) },
      { output: withFollowUp("Complete.", ["Q1", "F1", "Q2"], ["Q1", "F1"], "Q1: A\nRetries: 3\nQ2: default") },
      { output: noQuestions, plan: "v1" },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: withQuestions,
  });
  await runTask(layer);
  const counts = probe.ui.notified.flatMap((e) => (e._tag === "InterviewTurn" ? [`${e.answered} of ${e.total}`] : []));
  assert.deepEqual(counts, ["0 of 2", "1 of 3", "2 of 3"]);
});
