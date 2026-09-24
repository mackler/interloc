import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { run } from "../src/run.ts";
import type * as S from "../src/schema.ts";
import { context, finished, issue, respond, ScriptedUi, tempRepo } from "./helpers.ts";

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
  answered_ids: answered,
  complete: summary !== "",
  summary,
});
const read = (dir: string, name: string): string => fs.readFileSync(path.join(dir, name), "utf8");

test("question list is amended in review, the interview runs, the summary is confirmed, and planning follows", async () => {
  const repo = tempRepo();
  const ui = new ScriptedUi(["1", "B, because of X", ""]);
  const ctx = context(repo, ui,
    [
      { output: { questions: [q("Q1")] } },                                              // question list
      { output: { ...respond([["Q-R1-1", "accepted"]]), questions: [q("Q1"), q("Q2")] } }, // Codex: Q2 is missing
      { output: turn("Q1: A or B?", []) },                                                // interview
      { output: turn("Q2: A or B?", ["Q1"]) },
      { output: turn("Complete.", ["Q1", "Q2"], "# Requirements\n\nQ1: A\nQ2: B because of X") },
      { output: noQuestions, plan: "v1" },                                                // initial plan
    ],
    [{ issues: [issue("Q-R1-1", "Q2 is missing")] }, { issues: [] }, { issues: [] }, { issues: [] }],
    [finished], { questionPhase: true });
  await run(ctx, "task");

  const questions = JSON.parse(read(ctx.state.dir, "questions.json"));
  assert.equal(questions.task, "task");
  assert.deepEqual(questions.questions.map((x: QuestionEntry) => x.id), ["Q1", "Q2"]);
  assert.match(read(ctx.state.dir, "requirements.md"), /Q2: B because of X/);
  assert.equal(ctx.state.loadLog("questions-log.json")[0].action, "accepted");
  assert.equal(ctx.reviewer.phases, 3); // question review, requirements review, plan review
  assert.ok(ctx.planner.prompts.some((p) => p.includes("User: B, because of X")));
  assert.match(ctx.planner.prompts.at(-1) ?? "", /requirements\.md contains the user's confirmed answers/);
  const conversation = read(ctx.state.dir, "conversation.md");
  assert.match(conversation, /## Agreed question list/);
  assert.match(conversation, /\*\*User:\*\* B, because of X/);
  assert.match(conversation, /### Confirmed summary/);
});

test("an empty agreed list offers the conversation; Enter starts planning", async () => {
  const repo = tempRepo();
  const ui = new ScriptedUi([""]);
  const ctx = context(repo, ui, [{ output: { questions: [] } }, { output: noQuestions, plan: "v1" }], [{ issues: [] }, { issues: [] }], [finished], { questionPhase: true });
  await run(ctx, "task");
  assert.match(ui.asked[0], /no question is needed/);
  assert.match(read(ctx.state.dir, "requirements.md"), /No question was needed/);
  assert.equal(ctx.reviewer.phases, 2); // no requirements review without a conversation
});

test("an empty agreed list with a first message opens a conversation", async () => {
  const repo = tempRepo();
  const ui = new ScriptedUi(["use the existing logger", ""]);
  const ctx = context(repo, ui,
    [{ output: { questions: [] } }, { output: turn("Noted.", [], "# Requirements\n\nUse the existing logger.") }, { output: noQuestions, plan: "v1" }],
    [{ issues: [] }, { issues: [] }, { issues: [] }], [finished], { questionPhase: true });
  await run(ctx, "task");
  assert.ok(ctx.planner.prompts[1].includes("use the existing logger"));
  assert.match(read(ctx.state.dir, "requirements.md"), /existing logger/);
});

test("an unconfirmed summary continues the conversation", async () => {
  const repo = tempRepo();
  const ui = new ScriptedUi(["A", "Q1 is B, not A", ""]);
  const ctx = context(repo, ui,
    [
      { output: { questions: [q("Q1")] } },
      { output: turn("Q1?", []) },
      { output: turn("Complete.", ["Q1"], "Q1: A") },
      { output: turn("Corrected.", ["Q1"], "Q1: B") },
      { output: noQuestions, plan: "v1" },
    ],
    [{ issues: [] }, { issues: [] }, { issues: [] }], [finished], { questionPhase: true });
  await run(ctx, "task");
  assert.equal(read(ctx.state.dir, "requirements.md"), "Q1: B\n");
  assert.ok(ctx.planner.prompts.some((p) => p.startsWith("The user does not confirm the summary")));
});

test("a gap that Claude Code accepts produces a second interview and a revised requirements file", async () => {
  const repo = tempRepo();
  const ui = new ScriptedUi(["A", "", "retries: 3", ""]);
  const ctx = context(repo, ui,
    [
      { output: { questions: [q("Q1")] } },
      { output: turn("Q1?", []) },
      { output: turn("Complete.", ["Q1"], "Q1: A") },
      { output: respond([["G-R1-1", "accepted"]]) },                      // requirements review response
      { output: turn("How many retries?", []) },                          // second interview
      { output: turn("Complete.", ["G-R1-1"], "Q1: A\nRetries: 3") },
      { output: noQuestions, plan: "v1" },
    ],
    [{ issues: [] }, { issues: [issue("G-R1-1", "retry count absent")] }, { issues: [] }, { issues: [] }],
    [finished], { questionPhase: true });
  await run(ctx, "task");
  assert.equal(read(ctx.state.dir, "requirements.md"), "Q1: A\nRetries: 3\n");
  assert.match(read(ctx.state.dir, "conversation.md"), /## Second interview/);
  assert.equal(ctx.state.loadLog("requirements-log.json")[0].id, "G-R1-1");
});

test("/done ends the interview early", async () => {
  const repo = tempRepo();
  const ui = new ScriptedUi(["/done", ""]);
  const ctx = context(repo, ui,
    [{ output: { questions: [q("Q1")] } }, { output: turn("Q1?", []) }, { output: turn("Ended.", [], "Open points: Q1 -> default A") }, { output: noQuestions, plan: "v1" }],
    [{ issues: [] }, { issues: [] }, { issues: [] }], [finished], { questionPhase: true });
  await run(ctx, "task");
  assert.ok(ctx.planner.prompts.some((p) => p.startsWith("The user ends the interview now")));
  assert.match(read(ctx.state.dir, "requirements.md"), /default A/);
});
