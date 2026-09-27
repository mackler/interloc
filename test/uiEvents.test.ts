import assert from "node:assert/strict";
import { test } from "node:test";
import { describeEvent, type UiEvent } from "../src/uiEvents.ts";

const review = { issues: [] };
const response = { dispositions: [], self_corrections: [], reviewer_feedback: "", questions_for_user: [] };
const outcome = { status: "finished" as const, summary: "done", question: "", remainingWork: "", userInput: null };

// One example of every variant; the `satisfies` makes a missing tag a type error when the union grows.
const examples: { [K in UiEvent["_tag"]]: [Extract<UiEvent, { _tag: K }>, RegExp] } = {
  PhaseBegan: [{ _tag: "PhaseBegan", phase: { kind: "planning", n: 2 } }, /Planning 2 began/],
  PhaseEnded: [{ _tag: "PhaseEnded", phase: { kind: "questions" }, result: "done" }, /Question phase ended: done/],
  RoundBegan: [{ _tag: "RoundBegan", subject: { plan: 1 }, round: 3, limit: 10 }, /planning-1, round 3 of 10/],
  ReviewReceived: [{ _tag: "ReviewReceived", subject: "questions", round: 1, review, counted: 0 }, /review of question-review, round 1: 0 issues, 0 counted/],
  ResponseReceived: [{ _tag: "ResponseReceived", subject: "requirements", round: 2, response, resultText: "" }, /response in requirements-review, round 2/],
  LoopFinished: [{ _tag: "LoopFinished", subject: { plan: 1 }, result: "converged" }, /planning-1 finished: converged/],
  PlanWritten: [{ _tag: "PlanWritten", phase: 1, questions: ["a?"], resultText: "" }, /plan written in phase 1, 1 question/],
  ExecutionEnded: [{ _tag: "ExecutionEnded", phase: 1, outcome }, /execution 1 ended: finished/],
  AgentCallStarted: [{ _tag: "AgentCallStarted", agent: "codex", purpose: "review" }, /Codex call started: review/],
  ToolUsed: [{ _tag: "ToolUsed", agent: "claude", tool: "Read", target: "src/run.ts" }, /Claude Code used Read src\/run\.ts/],
  AgentCallEnded: [{ _tag: "AgentCallEnded", agent: "claude", ok: false }, /Claude Code call ended: failed/],
  QuestionAsked: [{ _tag: "QuestionAsked", question: "Which?", options: [{ label: "A", description: "" }] }, /question: Which\? \(1 option\)/],
  InterviewTurn: [{ _tag: "InterviewTurn", heading: "Interview", message: "Hello", summary: null }, /Interview: Hello/],
  InterviewOpened: [{ _tag: "InterviewOpened", heading: "Interview" }, /Interview opened/],
  ClaudeSaid: [{ _tag: "ClaudeSaid", text: "done" }, /Claude Code said: done/],
};

for (const [tag, [event, expected]] of Object.entries(examples)) {
  test(`describeEvent describes ${tag}`, () => {
    assert.match(describeEvent(event), expected);
  });
}
