// S6 and S7 (issue #46): every question the user is asked is presented the same way, numbered in one sequence for the
// run, whatever produced it; conversation.md records each under its number with the record's id beside it.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import * as prompts from "../src/prompts.ts";
import { questionLines } from "../src/render.ts";
import type { PresentedQuestion } from "../src/question.ts";
import { finished, issue, presentedQuestions, respond, runTask, tempRepo, testLayer } from "./helpers.ts";

const noQuestions = { questions_for_user: [] };
const entry = (id: string) => ({ id, context: "c", question: `question ${id}?`, reason: "r", proposed_answers: [{ label: "A", description: "a" }, { label: "B", description: "b" }], default_answer: "A" });
const asking = (id: string, answered: string[]) => ({
  message_to_user: `Next: ${id}.`,
  current_question: { id, context: `The context of ${id}.`, text: `question ${id}?`, terms: [], options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] },
  asked_ids: [...answered, id],
  answered_ids: answered,
  complete: false,
  summary: "",
});
const done = { message_to_user: "Done.", current_question: { id: "", context: "", text: "", terms: [], options: [] }, asked_ids: ["Q1", "Q2"], answered_ids: ["Q1", "Q2"], complete: true, summary: "# Requirements\n\nA and B." };
const plannerQuestion = { context: "Claude Code, the planning agent, writes the plan.", question: "Which database should the service use?", terms: [], options: [{ label: "SQLite", description: "a file" }, { label: "PostgreSQL", description: "a server" }] };

/** A run with two clarification questions, the summary's confirmation, a question of the plan writer and a pause. */
const scenario = () =>
  testLayer(tempRepo(), {
    // Q1, Q2, the confirmation, the plan writer's question, the pause on issue A raised again.
    answers: ["1", "2", "", "1", ""],
    steps: [
      { output: { questions: [entry("Q1"), entry("Q2")] } },
      { output: asking("Q1", []) },
      { output: asking("Q2", ["Q1"]) },
      { output: done },
      { output: { questions_for_user: [plannerQuestion] }, plan: "v1" },
      { output: noQuestions, plan: "v1" },
      { output: respond([["P1-R1-1", "rejected"]]) },
      { output: respond([["P1-R1-1", "rejected"]]) },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [issue("P1-R1-1")] }, { issues: [issue("P1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true, maxIdleRounds: 5 },
  });

test("S6: the questions are numbered in one sequence for the run, whatever produced them; the records keep their ids", async () => {
  const { layer, probe } = scenario();
  await runTask(layer);
  const questions = presentedQuestions(probe.ui);
  assert.deepEqual(
    questions.map((q) => [q.number, q.origin.kind]),
    [
      [1, "clarification"],
      [2, "clarification"],
      [3, "confirmSummary"],
      [4, "planner"],
      [5, "pause"],
    ],
  );
  const conversation = fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");
  for (const heading of ["### Question 1 (Q1)", "### Question 2 (Q2)", "### Question 3\n", "### Question 4\n", "### Question 5 (P1-R1-1)"]) assert.ok(conversation.includes(heading), heading);
  // The ids in the records and in the prompts to the agents are the records' own.
  assert.ok(!fs.readFileSync(path.join(probe.dir, "user-decisions.md"), "utf8").includes("Question 4"));
  assert.ok(probe.planner.prompts.every((p) => !/Question [0-9]/.test(p)));
});

test("S7: every ask is preceded by the presentation of its question, and every kind presents itself alike (issue #46)", async () => {
  const { layer, probe } = scenario();
  await runTask(layer);
  // Between two asks there is a presentation: none is asked without its question in view.
  const order = probe.ui.order;
  order.forEach((step, i) => {
    if (step !== "ask") return;
    const since = order.slice(0, i).lastIndexOf("ask");
    assert.ok(order.slice(since + 1, i).some((s) => s.startsWith("presented")), `ask ${i} came without a presented question: ${order.join(", ")}`);
  });
  const questions = presentedQuestions(probe.ui);
  const shape = (q: PresentedQuestion) => Object.keys(q).sort();
  for (const q of questions) {
    assert.deepEqual(shape(q), shape(questions[0]));
    const lines = questionLines(q).filter((l) => l !== "");
    assert.equal(lines[0], prompts.questionTitle(q.number));
    assert.ok(lines.includes(q.question.split("\n")[0]));
    assert.ok(q.context.text.trim() !== "", `question ${q.number} has no context`);
  }
});

test("S11: a pause reaches the user as prose: no line said and no question shown carries JSON (issue #19)", async () => {
  const { layer, probe } = scenario();
  await runTask(layer);
  const pause = presentedQuestions(probe.ui).find((q) => q.origin.kind === "pause");
  assert.ok(pause !== undefined);
  assert.match(pause.details, new RegExp(`^${prompts.pauseLead({ pause: "reraised", id: "P1-R1-1" })}`));
  assert.match(pause.details, /Codex says: p\n\ne/);
  const shown = [...probe.ui.said, ...presentedQuestions(probe.ui).flatMap((q) => [q.context.text, q.details, q.question, ...q.options.map((o) => o.description)])];
  for (const text of shown) for (const forbidden of ["{\n", '"duplicate_of"', "duplicate_of:", "superseded", "\\n"]) assert.ok(!text.includes(forbidden), `${forbidden} in: ${text}`);
});

// S12 (decision Q1): every question the program composes is explained by a context call, which the user reads as an
// agent's paragraph; the program's fixed question and options stand as the program wrote them.
test("S12: a pause, the cycle limit and the unchanged pause are presented with the context call's paragraph and terms", async () => {
  const explained = { context: "Codex, the reviewing agent, checks the plan that Claude Code, the planning agent, writes; this happens now, before the plan is carried out, so that the plan is right.", terms: [{ term: "Codex", explanation: "An AI agent that reviews the work." }] };
  const pause = scenario();
  pause.probe.planner.contexts = [{ output: explained }];
  await runTask(pause.layer);
  const paused = presentedQuestions(pause.probe.ui).find((q) => q.origin.kind === "pause");
  assert.deepEqual([paused?.context, paused?.terms], [{ text: explained.context, by: "agent" }, explained.terms]);
  assert.equal(paused?.question, prompts.pauseQuestion({ pause: "reraised", id: "P1-R1-1" }));
  // The context call was given the pause's facts, which the user also reads (S11).
  assert.ok(pause.probe.planner.contextPrompts[0].includes(paused?.details ?? "?"));

  const limit = testLayer(tempRepo(), {
    answers: ["p"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [] }],
    execs: [finished],
    config: { maxRounds: 1 },
  });
  await runTask(limit.layer);
  const [atLimit] = presentedQuestions(limit.probe.ui);
  assert.equal(atLimit.origin.kind, "limit");
  assert.equal(atLimit.context.by, "agent");
  assert.match(limit.probe.planner.contextPrompts[0], new RegExp(prompts.limitFacts("Planning phase 1", 1, [1]).replace(/[.()]/g, "\\$&")));

  const unchanged = testLayer(tempRepo(), {
    answers: [prompts.UNCHANGED_ANSWERS.proceed],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]) }, { output: respond([["P1-R1-1", "accepted"]]) }],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  });
  await runTask(unchanged.layer);
  const [kept] = presentedQuestions(unchanged.probe.ui);
  assert.equal(kept.origin.kind, "unchanged");
  assert.equal(kept.context.by, "agent");
  assert.match(unchanged.probe.planner.contextPrompts[0], /did not change, also after Claude Code was told so/);
});

test("S12: the questions that do not need one make no context call: the clarification, the plan writer's, the summary's", async () => {
  const { layer, probe } = scenario();
  await runTask(layer);
  // The one context call of the scenario is the pause's.
  assert.equal(probe.planner.contextPrompts.length, 1);
  const byKind = new Map(presentedQuestions(probe.ui).map((q) => [q.origin.kind, q.context]));
  assert.deepEqual(byKind.get("clarification"), { text: "The context of Q2.", by: "agent" });
  assert.deepEqual(byKind.get("planner"), { text: plannerQuestion.context, by: "agent" });
  assert.equal(byKind.get("confirmSummary")?.by, "program");
});
