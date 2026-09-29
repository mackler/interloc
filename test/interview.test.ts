import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type * as S from "../src/schema.ts";
import * as prompts from "../src/prompts.ts";
import { numberedOptionLabels } from "../src/userPrompts.ts";
import { finished, runFails, runTask, tempRepo, testLayer, presentedQuestions, presentedSubjects } from "./helpers.ts";
import { NUMBERED_MESSAGE } from "./interviewFixture.ts";

// Step 4.6 (finding 8; Q4): the interview matches on turn variants, and the question list is normalised.
type QuestionEntry = typeof S.QuestionEntry.Type;
const noQuestions = { questions_for_user: [] };
const q = (id: string, defaultAnswer = "A"): QuestionEntry => ({ id, context: "c", question: `question ${id}?`, reason: "r", proposed_answers: [{ label: "A", description: "a" }, { label: "B", description: "b" }], default_answer: defaultAnswer });
const turn = (message: string, complete: boolean, summary: string) => ({ message_to_user: message, current_question: { id: "", context: "", text: "", terms: [], options: [] }, asked_ids: [], answered_ids: [], complete, summary });
const read = (dir: string, name: string): string => fs.readFileSync(path.join(dir, name), "utf8");

test("a turn that is complete with a blank summary continues the conversation instead of proposing a summary", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["hi", "more", ""],
    steps: [
      { output: { questions: [] } },
      { output: turn("Anything to add?", true, "  ") },
      { output: turn("Done.", true, "# Requirements\n\nNone.") },
      { output: noQuestions, plan: "v1" },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true },
  });
  await runTask(layer);
  assert.ok(probe.ui.asked.some((p) => p.startsWith("You >")), "the blank summary was not treated as a continuing turn");
  assert.ok(probe.ui.said.includes("Gather Requirements: Claude Code formulates the question list ..."), probe.ui.said.join("\n"));
  assert.match(read(probe.dir, "requirements.md"), /None\./);
  assert.doesNotMatch(read(probe.dir, "conversation.md"), /Summary proposed by Claude Code:\n\n\s*\n/);
});

test("duplicate question ids halt with QuestionListInvalid before any review", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: { questions: [q("Q1"), q("Q1")] } }],
    config: { questionPhase: true },
  });
  await runFails(layer, "QuestionListInvalid", /Q1/);
  assert.equal(probe.reviewer.prompts.length, 0);
});

test("a default answer that names no proposed answer is recorded as null, with a note in the conversation", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["A", ""],
    steps: [
      { output: { questions: [q("Q1", "C")] } },
      { output: turn("Q1?", false, "") },
      { output: turn("Done.", true, "# Requirements\n\nQ1: A") },
      { output: noQuestions, plan: "v1" },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true },
  });
  await runTask(layer);
  const file = JSON.parse(read(probe.dir, "questions.json"));
  assert.equal(file.questions[0].default_answer, null);
  assert.match(read(probe.dir, "conversation.md"), /default answer.*Q1.*C/i);
});

// Plan step 1.5: the question phase is a phase of the progress display, and each interview turn is an event
// emitted before the terminal's lines of that turn, which stay unchanged.
test("the question phase notifies its beginning and end and every interview turn before its lines", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["hi", "more", ""],
    steps: [
      { output: { questions: [] } },
      { output: turn("Anything to add?", false, "") },
      { output: turn("Done.", true, "# Requirements\n\nNone.") },
      { output: noQuestions, plan: "v1" },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true },
  });
  await runTask(layer);
  // Issue #6: the run's shape is notified first, then the question phase begins.
  const tags = probe.ui.notified.map((e) => e._tag);
  assert.deepEqual(tags.slice(0, 2), ["PhasesForeseen", "PhaseBegan"]);
  assert.deepEqual(probe.ui.notified[1], { _tag: "PhaseBegan", phase: { kind: "questions" } });
  const turns = probe.ui.notified.filter((e) => e._tag === "InterviewTurn");
  assert.deepEqual(turns, [
    { _tag: "InterviewTurn", heading: "Conversation before planning", message: "Anything to add?", summary: null, answered: 0, total: 0 },
    { _tag: "InterviewTurn", heading: "Conversation before planning", message: "Done.", summary: "# Requirements\n\nNone.", answered: 0, total: 0 },
  ]);
  // Issue #21: the conversation after an empty agreed list is a clarification with nothing agreed to count.
  assert.deepEqual(probe.ui.notified.find((e) => e._tag === "InterviewOpened"), { _tag: "InterviewOpened", heading: "Conversation before planning", stage: "conversation", total: 0 });
  assert.ok(probe.ui.notified.some((e) => e._tag === "PhaseEnded" && e.phase.kind === "questions"));
  assert.ok(tags.indexOf("PhaseEnded") < tags.lastIndexOf("PhaseBegan"), "the question phase ends before planning begins");
  // The terminal line of a turn is unchanged; S7: the summary is shown in the context of the question that confirms it.
  assert.ok(probe.ui.said.includes("\nAnything to add?\n"));
  const confirm = presentedQuestions(probe.ui).find((q) => q.origin.kind === "confirmSummary");
  assert.match(confirm?.details ?? "", /# Requirements\n\nNone\./);
  assert.equal(confirm?.question, prompts.CONFIRM_SUMMARY_QUESTION);
});

// Finding 8 of docs/gui-review.md: the interview's opening help is a structured event, rendered per interface.
test("the interview's opening is an InterviewOpened event, not a terminal-only say", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["hi", ""],
    steps: [{ output: { questions: [] } }, { output: turn("Done.", true, "# Requirements\n\nNone.") }, { output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true },
  });
  await runTask(layer);
  assert.ok(probe.ui.notified.some((e) => e._tag === "InterviewOpened"), "no InterviewOpened event");
  assert.ok(!probe.ui.said.some((line) => line.includes('"""')), "the terminal's multiline convention was said to every interface");
});

// Decision support, plan step 3.5: an interview turn's numbered answers carry the offer; the decision is in the
// requirements phase, and the chosen answer goes on to Claude Code as typed.
test("an interview turn with numbered answers offers Help me decide; after the analysis the number is the answer", async () => {
  const labels = numberedOptionLabels(NUMBERED_MESSAGE).map((c) => c.label);
  const el = { text: "t", counterarguments: [] };
  const entry = (id: string) => ({ id, title: id, comparative_condition: el, starting_cause: el, intermediate_steps: el, threshold: el, effect_on_persons: el, reason_the_effect_matters: el, extent: { per_person: el, persons_affected: el, likelihood: el, timing: el } });
  const analysis = { decision: "d", columns: labels.map((option, i) => ({ kind: "argued", option, advantages: [entry(`E${i + 1}`)], disadvantages: [] })), recommendation: { option: "", reason: "" } };
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["/decide", "2", ""],
    steps: [
      { output: { questions: [q("Q1")] } },
      { output: turn(NUMBERED_MESSAGE, false, "") },
      { output: analysis },
      { output: turn("Done.", true, "# Requirements\n\nQ1: SQLite") },
      { output: noQuestions, plan: "v1" },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true },
  });
  await runTask(layer);
  assert.ok(probe.ui.asked.filter((p) => p.endsWith("You > ")).every((p) => p.startsWith(prompts.OFFER_LINE)));
  const question = JSON.parse(read(probe.dir, "decision-1/question.json"));
  assert.deepEqual(question.phase, { kind: "questions" });
  assert.deepEqual(question.options.map((o: { label: string }) => o.label), labels);
  assert.equal(JSON.parse(read(probe.dir, "decision-1/chosen.json")).option, labels[1]);
  assert.match(probe.planner.prompts[3], /\b2\b/);
});

// W1-R1-1: a blank reply after the analysis is not the choice; the answer that follows is.
test("an interview turn answered /decide, blank, 2 records option 2", async () => {
  const labels = numberedOptionLabels(NUMBERED_MESSAGE).map((c) => c.label);
  const el = { text: "t", counterarguments: [] };
  const entry = (id: string) => ({ id, title: id, comparative_condition: el, starting_cause: el, intermediate_steps: el, threshold: el, effect_on_persons: el, reason_the_effect_matters: el, extent: { per_person: el, persons_affected: el, likelihood: el, timing: el } });
  const analysis = { decision: "d", columns: labels.map((option, i) => ({ kind: "argued", option, advantages: [entry(`E${i + 1}`)], disadvantages: [] })), recommendation: { option: "", reason: "" } };
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["/decide", "", "2", ""],
    steps: [
      { output: { questions: [q("Q1")] } },
      { output: turn(NUMBERED_MESSAGE, false, "") },
      { output: analysis },
      { output: turn("Done.", true, "# Requirements\n\nQ1: SQLite") },
      { output: noQuestions, plan: "v1" },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true },
  });
  await runTask(layer);
  assert.deepEqual(JSON.parse(read(probe.dir, "decision-1/chosen.json")), { version: 2, decision: 1, answer: "2", option: labels[1] });
});

// W2-R1-2: an interview option chosen by its label is recorded as that option; the columns are the bare labels.
test("an interview turn answered /decide, then a label, records that option; the question's options are the bare labels", async () => {
  const labels = ["PostgreSQL", "SQLite", "Both, chosen by configuration"];
  const el = { text: "t", counterarguments: [] };
  const entry = (id: string) => ({ id, title: id, comparative_condition: el, starting_cause: el, intermediate_steps: el, threshold: el, effect_on_persons: el, reason_the_effect_matters: el, extent: { per_person: el, persons_affected: el, likelihood: el, timing: el } });
  const analysis = { decision: "d", columns: labels.map((option, i) => ({ kind: "argued", option, advantages: [entry(`E${i + 1}`)], disadvantages: [] })), recommendation: { option: "", reason: "" } };
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["/decide", "SQLite", ""],
    steps: [
      { output: { questions: [q("Q1")] } },
      { output: turn(NUMBERED_MESSAGE, false, "") },
      { output: analysis },
      { output: turn("Done.", true, "# Requirements\n\nQ1: SQLite") },
      { output: noQuestions, plan: "v1" },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true },
  });
  await runTask(layer);
  assert.deepEqual(JSON.parse(read(probe.dir, "decision-1/question.json")).options.map((o: { label: string }) => o.label), labels);
  assert.deepEqual(JSON.parse(read(probe.dir, "decision-1/chosen.json")), { version: 2, decision: 1, answer: "SQLite", option: "SQLite" });
});

// Issue #35 (Q5, Q6): the decision's question is the current question alone, its number written out; the message with
// the record of the previous answer, the options and the default is not.
test("Help me decide on an interview turn names the current question, Question <n>: text, not the whole message", async () => {
  const labels = numberedOptionLabels(NUMBERED_MESSAGE).map((c) => c.label);
  const el = { text: "t", counterarguments: [] };
  const entry = (id: string) => ({ id, title: id, comparative_condition: el, starting_cause: el, intermediate_steps: el, threshold: el, effect_on_persons: el, reason_the_effect_matters: el, extent: { per_person: el, persons_affected: el, likelihood: el, timing: el } });
  const analysis = { decision: "d", columns: labels.map((option, i) => ({ kind: "argued", option, advantages: [entry(`E${i + 1}`)], disadvantages: [] })), recommendation: { option: "", reason: "" } };
  const message = `Q3 recorded: changed flag.\n\nQ4. Should you also see that a response left the file unchanged?\n${NUMBERED_MESSAGE}\nDefault: 1.`;
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["/decide", "2", ""],
    steps: [
      { output: { questions: [q("Q4")] } },
      { output: { ...turn(message, false, ""), current_question: { id: "Q4", context: "", text: "Should you also see that a response left the file unchanged?", terms: [], options: [] } } },
      { output: analysis },
      { output: turn("Done.", true, "# Requirements\n\nQ4: 2") },
      { output: noQuestions, plan: "v1" },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true },
  });
  await runTask(layer);
  // S5: the number is the run's (in the question's heading), not part of the decision's question.
  const expected = "Should you also see that a response left the file unchanged?";
  assert.equal(JSON.parse(read(probe.dir, "decision-1/question.json")).question, expected);
  const analyzed = probe.ui.notified.find((e) => e._tag === "DecisionAnalyzed");
  assert.equal(analyzed?._tag === "DecisionAnalyzed" ? analyzed.question : null, expected);
  assert.match(probe.planner.prompts[2], new RegExp(`The decision: ${expected.replace(/[?]/g, "\\?")}\n`));
  // The user still reads Claude's whole message in the interview.
  assert.ok(probe.ui.said.some((line) => line.includes("Q3 recorded")), probe.ui.said.join("\n"));
});

test("a turn without a current question offers the decision on the whole message, as before", async () => {
  const labels = numberedOptionLabels(NUMBERED_MESSAGE).map((c) => c.label);
  const el = { text: "t", counterarguments: [] };
  const entry = (id: string) => ({ id, title: id, comparative_condition: el, starting_cause: el, intermediate_steps: el, threshold: el, effect_on_persons: el, reason_the_effect_matters: el, extent: { per_person: el, persons_affected: el, likelihood: el, timing: el } });
  const analysis = { decision: "d", columns: labels.map((option, i) => ({ kind: "argued", option, advantages: [entry(`E${i + 1}`)], disadvantages: [] })), recommendation: { option: "", reason: "" } };
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["/decide", "2", ""],
    steps: [{ output: { questions: [q("Q1")] } }, { output: turn(NUMBERED_MESSAGE, false, "") }, { output: analysis }, { output: turn("Done.", true, "# R") }, { output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
    config: { questionPhase: true },
  });
  await runTask(layer);
  assert.equal(JSON.parse(read(probe.dir, "decision-1/question.json")).question, NUMBERED_MESSAGE);
});
