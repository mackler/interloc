import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type * as S from "../src/schema.ts";
import { finished, runFails, runTask, tempRepo, testLayer } from "./helpers.ts";

// Step 4.6 (finding 8; Q4): the interview matches on turn variants, and the question list is normalised.
type QuestionEntry = typeof S.QuestionEntry.Type;
const noQuestions = { questions_for_user: [] };
const q = (id: string, defaultAnswer = "A"): QuestionEntry => ({ id, question: `question ${id}?`, reason: "r", proposed_answers: [{ label: "A", description: "a" }, { label: "B", description: "b" }], default_answer: defaultAnswer });
const turn = (message: string, complete: boolean, summary: string) => ({ message_to_user: message, answered_ids: [], complete, summary });
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
  const tags = probe.ui.notified.map((e) => e._tag);
  assert.equal(tags[0], "PhaseBegan");
  assert.deepEqual(probe.ui.notified[0], { _tag: "PhaseBegan", phase: { kind: "questions" } });
  const turns = probe.ui.notified.filter((e) => e._tag === "InterviewTurn");
  assert.deepEqual(turns, [
    { _tag: "InterviewTurn", heading: "Conversation before planning", message: "Anything to add?", summary: null },
    { _tag: "InterviewTurn", heading: "Conversation before planning", message: "Done.", summary: "# Requirements\n\nNone." },
  ]);
  assert.ok(probe.ui.notified.some((e) => e._tag === "PhaseEnded" && e.phase.kind === "questions"));
  assert.ok(tags.indexOf("PhaseEnded") < tags.lastIndexOf("PhaseBegan"), "the question phase ends before planning begins");
  // The terminal lines of the turns are unchanged.
  assert.ok(probe.ui.said.includes("\nAnything to add?\n"));
  assert.ok(probe.ui.said.includes("Summary proposed by Claude Code:\n\n# Requirements\n\nNone.\n"));
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
