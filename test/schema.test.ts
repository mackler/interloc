import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import * as S from "../src/schema.ts";
import type * as legacy from "./fixtures/legacy-types.ts";

// Type-level comparison, insensitive to readonly modifiers: Effect's Struct types are readonly,
// the frozen legacy types are not.
type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const sameType = <_T extends true>(): void => {};

const decode = <T>(schema: Schema.ConstraintDecoder<T>, value: unknown): T =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
const rejects = <T>(schema: Schema.ConstraintDecoder<T>, value: unknown, what: string): void =>
  assert.throws(() => decode(schema, value), `${what} was accepted`);

const issue: legacy.Issue = { id: "P1-R1-1", severity: "major", location: "step 3", problem: "p", evidence: "e" };
const disposition: legacy.Disposition = { id: "P1-R1-1", action: "accepted", rationale: "r", duplicate_of: "", reverses: "" };
const selfCorrection: legacy.SelfCorrection = { id: "A", new_action: "plan_error", explanation: "x" };
const plannerResponse: legacy.PlannerResponse = { dispositions: [disposition], self_corrections: [selfCorrection], reviewer_feedback: "", questions_for_user: ["q?"] };
const questionEntry: legacy.QuestionEntry = { id: "Q1", question: "q?", reason: "r", proposed_answers: [{ label: "A", description: "a" }], default_answer: "A" };
const interviewTurn: legacy.InterviewTurn = { message_to_user: "m", answered_ids: ["Q1"], complete: false, summary: "" };
const execReport: legacy.ExecReport = { status: "finished", summary: "s", question: "", remaining_work: "" };
const execOutcome: legacy.ExecOutcome = { status: "needs_input", summary: "s", question: "q", remainingWork: "w", userInput: null };
const logEntry: legacy.LogEntry = { id: "A", phase: 1, round: 2, source: "review", problem: "p", action: "accepted", rationale: "r" };
const config: legacy.Config = { questionPhase: true, ignorePaths: ["a.txt"], maxRounds: 5, maxIdleRounds: 2, countMinor: true, execPermissionMode: "auto", claudeModel: null, codexModel: null };

test("each schema decodes a valid sample and its type matches the legacy type", () => {
  assert.deepEqual(decode(S.Issue, issue), issue);
  assert.deepEqual(decode(S.Review, { issues: [issue] }), { issues: [issue] });
  assert.deepEqual(decode(S.Disposition, disposition), disposition);
  assert.deepEqual(decode(S.SelfCorrection, selfCorrection), selfCorrection);
  assert.deepEqual(decode(S.PlannerResponse, plannerResponse), plannerResponse);
  assert.deepEqual(decode(S.PlanWriteResult, { questions_for_user: [] }), { questions_for_user: [] });
  assert.deepEqual(decode(S.QuestionEntry, questionEntry), questionEntry);
  assert.deepEqual(decode(S.QuestionList, { questions: [questionEntry] }), { questions: [questionEntry] });
  assert.deepEqual(decode(S.QuestionListResponse, { ...plannerResponse, questions: [questionEntry] }), { ...plannerResponse, questions: [questionEntry] });
  assert.deepEqual(decode(S.InterviewTurn, interviewTurn), interviewTurn);
  assert.deepEqual(decode(S.ExecReport, execReport), execReport);
  assert.deepEqual(decode(S.ExecOutcome, execOutcome), execOutcome);
  assert.deepEqual(decode(S.LogEntry, logEntry), logEntry);
  assert.deepEqual(decode(S.LogEntry, { ...logEntry, severity: "minor", location: "l", evidence: "e", duplicate_of: "", reverses: "", superseded: true }).severity, "minor");
  assert.deepEqual(decode(S.Config, config), config);
  assert.deepEqual(decode(S.QuestionsFile, { task: "t", questions: [questionEntry] }).task, "t");
  assert.equal(decode(S.UsageEntry, { time: "2026-09-24T00:00:00.000Z", agent: "claude" }).agent, "claude");

  sameType<Equals<DeepMutable<typeof S.Issue.Type>, DeepMutable<legacy.Issue>>>();
  sameType<Equals<DeepMutable<typeof S.Review.Type>, DeepMutable<legacy.Review>>>();
  sameType<Equals<DeepMutable<typeof S.Disposition.Type>, DeepMutable<legacy.Disposition>>>();
  sameType<Equals<DeepMutable<typeof S.SelfCorrection.Type>, DeepMutable<legacy.SelfCorrection>>>();
  sameType<Equals<DeepMutable<typeof S.PlannerResponse.Type>, DeepMutable<legacy.PlannerResponse>>>();
  sameType<Equals<DeepMutable<typeof S.PlanWriteResult.Type>, DeepMutable<legacy.PlanWriteResult>>>();
  sameType<Equals<DeepMutable<typeof S.QuestionEntry.Type>, DeepMutable<legacy.QuestionEntry>>>();
  sameType<Equals<DeepMutable<typeof S.QuestionList.Type>, DeepMutable<legacy.QuestionList>>>();
  sameType<Equals<DeepMutable<typeof S.QuestionListResponse.Type>, DeepMutable<legacy.QuestionListResponse>>>();
  sameType<Equals<DeepMutable<typeof S.InterviewTurn.Type>, DeepMutable<legacy.InterviewTurn>>>();
  sameType<Equals<DeepMutable<typeof S.ExecReport.Type>, DeepMutable<legacy.ExecReport>>>();
  sameType<Equals<DeepMutable<typeof S.ExecOutcome.Type>, DeepMutable<legacy.ExecOutcome>>>();
  sameType<Equals<DeepMutable<typeof S.LogEntry.Type>, DeepMutable<legacy.LogEntry>>>();
  sameType<Equals<DeepMutable<typeof S.Config.Type>, DeepMutable<legacy.Config>>>();
});

test("each schema rejects a wrong enum value, a missing field and a wrong type", () => {
  rejects(S.Issue, { ...issue, severity: "huge" }, "severity huge");
  rejects(S.Issue, { id: "A", severity: "major", location: "l", problem: "p" }, "an issue without evidence");
  rejects(S.Review, { issues: issue }, "issues that are not an array");
  rejects(S.Disposition, { ...disposition, action: "maybe" }, "action maybe");
  rejects(S.Disposition, { id: "A", action: "accepted", rationale: "r" }, "a disposition without duplicate_of and reverses");
  rejects(S.SelfCorrection, { ...selfCorrection, new_action: "corrected" }, "new_action corrected");
  rejects(S.PlannerResponse, { ...plannerResponse, reviewer_feedback: 1 }, "numeric reviewer_feedback");
  rejects(S.QuestionEntry, { ...questionEntry, proposed_answers: [{ label: "A" }] }, "a proposed answer without a description");
  rejects(S.InterviewTurn, { ...interviewTurn, complete: "yes" }, "complete as a string");
  rejects(S.ExecReport, { ...execReport, status: "done" }, "status done");
  rejects(S.ExecOutcome, { ...execOutcome, userInput: 5 }, "numeric userInput");
  rejects(S.LogEntry, { ...logEntry, source: "robot" }, "source robot");
  rejects(S.LogEntry, { ...logEntry, phase: "1" }, "phase as a string");
  rejects(S.Config, { ...config, maxRounds: "5" }, "maxRounds as a string");
  rejects(S.Config, { ...config, execPermissionMode: "yolo" }, "execPermissionMode yolo");
  rejects(S.QuestionsFile, { questions: [questionEntry] }, "a questions file without a task");
});

test("Config rejects an unknown key", () => {
  rejects(S.Config, { ...config, maxRound: 3 }, "a misspelled key");
});

// Finding 5 of docs/functional-design-review.md: the program's own records accepted nonsensical numbers and empty ids.
test("the program's record schemas constrain counts, costs and ids", () => {
  for (const bad of [-0.5, 0, 1.5, 2 ** 53]) {
    rejects(S.Config, { ...config, maxRounds: bad }, `maxRounds ${bad}`);
    rejects(S.Config, { ...config, maxIdleRounds: bad }, `maxIdleRounds ${bad}`);
  }
  assert.equal(decode(S.Config, { ...config, maxRounds: 1, maxIdleRounds: 1 }).maxRounds, 1);
  rejects(S.LogEntry, { ...logEntry, phase: -1 }, "phase -1");
  rejects(S.LogEntry, { ...logEntry, round: 0.5 }, "round 0.5");
  rejects(S.LogEntry, { ...logEntry, id: "" }, "an empty log entry id");
  assert.equal(decode(S.LogEntry, { ...logEntry, phase: 0, round: 1 }).phase, 0);
  const usage = { time: "t", agent: "claude", num_turns: 0, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } };
  assert.equal(decode(S.UsageEntry, usage).num_turns, 0);
  rejects(S.UsageEntry, { ...usage, num_turns: -1 }, "num_turns -1");
  rejects(S.UsageEntry, { ...usage, total_cost_usd: -0.01 }, "a negative cost");
  rejects(S.UsageEntry, { ...usage, usage: { input_tokens: -1, output_tokens: 0 } }, "negative input tokens");
  rejects(S.UsageEntry, { ...usage, usage: { input_tokens: 0, output_tokens: -1 } }, "negative output tokens");
  rejects(S.QuestionsFile, { task: "t", questions: [{ ...questionEntry, id: "" }] }, "an empty question id in questions.json");
});
