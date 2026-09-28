import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import fc from "fast-check";
import { Schema } from "effect";
import { type ClientMessage, decodeClient, decodeServer, inSnapshot, type RunEvent, type RunRecord, type ServerMessage, type Stamped } from "../src/protocol.ts";
import type { SubjectId } from "../src/artifacts.ts";
import type { Subject } from "../src/review.ts";
import type { DecisionResponse, PlannerResponse, QuestionListResponse } from "../src/schema.ts";
import { decisionSubject, planSubject, questionSubject, requirementsSubject, workSubject } from "../src/subjects.ts";
import { Effect } from "effect";
import type { UiEvent } from "../src/uiEvents.ts";
import { promptOf } from "../src/userPrompts.ts";
import * as prompts from "../src/prompts.ts";

// Plan step 3.1: both sides decode with the same schemas; every variant survives the JSON round trip.
const nat = fc.nat({ max: 10_000 });
const text = fc.string({ maxLength: 20 });
const subject = fc.oneof(fc.constant("questions" as const), fc.constant("requirements" as const), nat.map((plan) => ({ plan })), nat.map((work) => ({ work })), nat.map((decision) => ({ decision })));
const phase = fc.oneof(fc.constant({ kind: "questions" as const }), fc.record({ kind: fc.constantFrom("planning" as const, "execution" as const, "work" as const), n: nat }));
const agent = fc.constantFrom("claude" as const, "codex" as const);
const reviewIssue = fc.record({ id: fc.string({ minLength: 1, maxLength: 8 }), severity: fc.constantFrom("blocking" as const, "major" as const, "minor" as const), location: text, problem: text, evidence: text });
const review = fc.record({ issues: fc.array(reviewIssue, { maxLength: 3 }) });
const userQuestion = fc.record({ question: text, options: fc.array(fc.record({ label: text, description: text }), { maxLength: 2 }) });
const disposition = fc.record({ id: text, action: fc.constantFrom("accepted" as const, "rejected" as const, "partially_accepted" as const, "no_change_needed" as const, "clarification_requested" as const), rationale: text, duplicate_of: text, reverses: text });
const plannerResponse = fc.record({
  dispositions: fc.array(disposition, { maxLength: 3 }),
  self_corrections: fc.array(fc.record({ id: text, new_action: fc.constantFrom("accepted" as const, "rejected" as const, "plan_error" as const), explanation: text }), { maxLength: 2 }),
  reviewer_feedback: text,
  questions_for_user: fc.array(userQuestion, { maxLength: 2 }),
});
const questionEntry = fc.record({ id: text, question: text, reason: text, proposed_answers: fc.array(fc.record({ label: text, description: text }), { maxLength: 2 }), default_answer: text });
// Defect A of docs/page-question-phase-defects.md: the question subject's response carries the amended list too.
const response = fc.oneof(plannerResponse, fc.tuple(plannerResponse, fc.array(questionEntry, { maxLength: 2 })).map(([r, questions]) => ({ ...r, questions })));
const outcome = fc.record({ status: fc.constantFrom("finished" as const, "needs_input" as const, "blocked" as const, "aborted" as const), summary: text, question: text, remainingWork: text, userInput: fc.option(text, { nil: null }) });
const uiEvent: fc.Arbitrary<UiEvent> = fc.oneof(
  phase.map((p) => ({ _tag: "PhaseBegan" as const, phase: p })),
  fc.record({ _tag: fc.constant("PhaseEnded" as const), phase, result: text }),
  fc.record({ _tag: fc.constant("RoundBegan" as const), subject, round: nat, limit: nat }),
  fc.record({ _tag: fc.constant("ReviewReceived" as const), subject, round: nat, review, counted: nat }),
  fc.record({ _tag: fc.constant("ResponseReceived" as const), subject, round: nat, response, resultText: text }),
  fc.record({ _tag: fc.constant("LoopFinished" as const), subject, result: fc.constantFrom("converged" as const, "proceed" as const, "revise" as const) }),
  fc.record({ _tag: fc.constant("PlanWritten" as const), phase: nat, questions: fc.array(userQuestion, { maxLength: 2 }), resultText: text }),
  fc.record({ _tag: fc.constant("ExecutionEnded" as const), phase: nat, outcome }),
  fc.record({ _tag: fc.constant("AgentCallStarted" as const), agent, purpose: text }),
  fc.record({ _tag: fc.constant("ToolUsed" as const), agent, tool: text, target: text }),
  fc.record({ _tag: fc.constant("AgentCallEnded" as const), agent, ok: fc.boolean() }),
  fc.record({ _tag: fc.constant("QuestionAsked" as const), question: text, options: fc.array(fc.record({ label: text, description: text }), { maxLength: 3 }) }),
  fc.record({ _tag: fc.constant("InterviewTurn" as const), heading: text, message: text, summary: fc.option(text, { nil: null }), answered: nat, total: nat }),
  fc.record({ _tag: fc.constant("InterviewOpened" as const), heading: text, stage: fc.constantFrom("clarification" as const, "followUp" as const, "conversation" as const), total: nat }),
  fc.record({ _tag: fc.constant("ClaudeSaid" as const), text }),
  fc.record({ _tag: fc.constant("OptionsPresented" as const), question: text, options: fc.array(fc.record({ label: text, description: text }), { maxLength: 3 }) }),
  fc.record({
    _tag: fc.constant("DecisionAnalyzed" as const),
    decision: nat,
    question: text,
    options: fc.array(fc.record({ label: text, description: text }), { maxLength: 3 }),
    analysis: fc.record({ decision: text, columns: fc.array(fc.record({ option: text, advantages: fc.constant([]), disadvantages: fc.constant([]) }), { maxLength: 2 }), recommendation: fc.record({ option: text, reason: text }) }),
  }),
);
const promptTexts = [prompts.decisionPrompt("x"), prompts.limitPrompt(3, "go"), prompts.permissionPrompt, prompts.interviewMessagePrompt, "unknown > "];
const runEvent: fc.Arbitrary<RunEvent> = fc.oneof(
  fc.record({ _tag: fc.constant("Started" as const), project: text, task: text }),
  fc.record({ _tag: fc.constant("Said" as const), text }),
  fc.tuple(nat, fc.constantFrom(...promptTexts)).map(([prompt, t]): RunEvent => ({ _tag: "Asked", prompt, ...promptOf(t) })),
  fc.record({ _tag: fc.constant("Answered" as const), prompt: nat, text }),
  uiEvent.map((event) => ({ _tag: "Notified" as const, event })),
  fc.record({ _tag: fc.constant("Ended" as const), code: fc.constantFrom(0, 1, 2, 130) }),
);
// Issue #1: every event carries the time of its publication, beside its seq, not inside the variant.
const stamped: fc.Arbitrary<Stamped> = fc.record({ time: text, event: runEvent });
const runRecord: fc.Arbitrary<RunRecord> = fc.record({ id: nat, events: fc.array(stamped, { maxLength: 4 }) });
const client: fc.Arbitrary<ClientMessage> = fc.oneof(
  fc.record({ type: fc.constant("start" as const), project: text, task: text }),
  fc.record({ type: fc.constant("answer" as const), incarnation: text, run: nat, prompt: nat, text }),
  fc.record({ type: fc.constant("stop" as const), incarnation: text, run: nat }),
  fc.record({ type: fc.constant("list" as const), path: text }),
);
const server: fc.Arbitrary<ServerMessage> = fc.oneof(
  fc.record({ type: fc.constant("hello" as const), cwd: text, current: fc.option(nat, { nil: null }), incarnation: text }),
  fc.constant({ type: "closing" as const }),
  fc.record({ type: fc.constant("replay" as const), runs: fc.array(runRecord, { maxLength: 2 }) }),
  fc.record({ type: fc.constant("event" as const), run: nat, seq: nat, time: text, event: runEvent }),
  fc.record({ type: fc.constant("listing" as const), path: text, parent: fc.option(text, { nil: null }), dirs: fc.array(text, { maxLength: 3 }), error: fc.option(text, { nil: null }) }),
  fc.record({ type: fc.constant("refused" as const), reason: text }),
);

/** The value as plain objects (fast-check's records have no prototype, which strict deepEqual distinguishes). */
const plain = <A>(value: A): A => JSON.parse(JSON.stringify(value));
const decoded = <A>(r: Result.Result<A, string>): A => {
  assert.ok(Result.isSuccess(r), `not decoded: ${Result.isFailure(r) ? r.failure : ""}`);
  return r.success;
};

test("a start message decodes", () => {
  assert.deepEqual(decoded(decodeClient(JSON.stringify({ type: "start", project: "/p", task: "t" }))), { type: "start", project: "/p", task: "t" });
});

test("property: every client message survives the JSON round trip", () => {
  fc.assert(fc.property(client, (m) => assert.deepEqual(decoded(decodeClient(JSON.stringify(m))), plain(m))));
});

test("property: every server message survives the JSON round trip", () => {
  fc.assert(fc.property(server, (m) => assert.deepEqual(decoded(decodeServer(JSON.stringify(m))), plain(m))), { numRuns: 200 });
});

// A stop or an answer without its incarnation (the shape before finding 12) is refused too.
test("a frame that is not JSON, or not a message, or has an unknown field, is refused", () => {
  for (const frame of ["not json", "{}", JSON.stringify({ type: "start", project: "/p" }), JSON.stringify({ type: "stop", run: "1" }), JSON.stringify({ type: "stop", run: 1, extra: true }), JSON.stringify({ type: "stop", run: 1 }), JSON.stringify({ type: "answer", run: 1, prompt: 1, text: "x" })]) {
    assert.ok(Result.isFailure(decodeClient(frame)), frame);
  }
});

const T = "2026-09-27T14:03:27.000Z";

// Issue #1: a frame or a replay entry without its time, or a Started with the time it carried before, is refused.
test("an event frame without its time, a bare replay entry, and a Started that still carries a time are refused", () => {
  const said = { _tag: "Said", text: "x" };
  for (const frame of [
    { type: "event", run: 1, seq: 0, event: said },
    { type: "replay", runs: [{ id: 1, events: [said] }] },
    { type: "event", run: 1, seq: 0, time: T, event: { _tag: "Started", project: "/p", task: "t", time: T } },
    { type: "replay", runs: [{ id: 1, events: [{ event: said }] }] },
  ]) assert.ok(Result.isFailure(decodeServer(JSON.stringify(frame))), JSON.stringify(frame));
  const ok: ServerMessage = { type: "event", run: 1, seq: 0, time: T, event: { _tag: "Started", project: "/p", task: "t" } };
  assert.deepEqual(decoded(decodeServer(JSON.stringify(ok))), ok);
});

// P1-R1-2 (both rounds): the boundary is kept for every replayed run.
const position = fc.record({ run: fc.nat({ max: 5 }), seq: fc.nat({ max: 60 }) });
const replayed = fc.uniqueArray(fc.record({ id: fc.nat({ max: 5 }), count: fc.nat({ max: 60 }) }), { selector: (r) => r.id, maxLength: 2 }).map((rs) => rs.map((r): RunRecord => ({ id: r.id, events: Array.from({ length: r.count }, () => ({ time: T, event: { _tag: "Said" as const, text: "" } })) })));

test("property: inSnapshot drops exactly the first events.length events of each replayed run, and nothing of another run", () => {
  fc.assert(
    fc.property(replayed, position, (runs, message) => {
      const run = runs.find((r) => r.id === message.run);
      assert.equal(inSnapshot(runs, message), run !== undefined && message.seq < run.events.length);
    }),
  );
});

test("inSnapshot: with an empty replay nothing is dropped; a later run passes from seq 0; an ended run is filtered too", () => {
  assert.equal(inSnapshot([], { run: 1, seq: 0 }), false);
  const a: RunRecord = { id: 1, events: Array.from({ length: 50 }, () => ({ time: T, event: { _tag: "Said" as const, text: "" } })) };
  assert.equal(inSnapshot([a], { run: 2, seq: 0 }), false);
  assert.equal(inSnapshot([a], { run: 1, seq: 49 }), true);
  assert.equal(inSnapshot([a], { run: 1, seq: 50 }), false);
});

// Defect A of docs/page-question-phase-defects.md: a question review's response is a QuestionListResponse, the planner's
// response plus the amended list; the page's decoding refused it, and with it the whole replay.
const questionListResponse: QuestionListResponse = {
  dispositions: [{ id: "Q-R1-1", action: "accepted", rationale: "Added the database question.", duplicate_of: "", reverses: "" }],
  self_corrections: [],
  reviewer_feedback: "",
  questions_for_user: [],
  questions: [{ id: "Q1", question: "Which database?", reason: "r", proposed_answers: [{ label: "PostgreSQL", description: "p" }], default_answer: "PostgreSQL" }],
};
const responseEvent = (subject: SubjectId, response: QuestionListResponse | Omit<QuestionListResponse, "questions"> | DecisionResponse): RunEvent => ({ _tag: "Notified", event: { _tag: "ResponseReceived", subject, round: 1, response, resultText: "" } });

test("a question review's ResponseReceived survives the round trip, live and in a replay", () => {
  const event: ServerMessage = { type: "event", run: 1, seq: 5, time: T, event: { _tag: "Notified", event: { _tag: "ResponseReceived", subject: "questions", round: 1, response: questionListResponse, resultText: "" } } };
  assert.deepEqual(decoded(decodeServer(JSON.stringify(event))), event);
  const replay: ServerMessage = { type: "replay", runs: [{ id: 1, events: [{ time: event.time, event: event.event }] }] };
  assert.deepEqual(decoded(decodeServer(JSON.stringify(replay))), replay);
});

const decisionAnalysis = { decision: "d", columns: [{ option: "A", advantages: [], disadvantages: [] }, { option: "B", advantages: [], disadvantages: [] }], recommendation: { option: "", reason: "" } };
const decisionResponseSchema = decisionSubject(1, 1, "format", () => Effect.void).respond.schema;

test("every subject's response, as its own schema decodes it, survives the round trip inside a ResponseReceived", () => {
  const { questions: _questions, ...plannerResponse } = questionListResponse;
  const subjects = [
    { subject: "questions" as SubjectId, schema: questionSubject("t").respond.schema, example: questionListResponse },
    { subject: "requirements" as const, schema: requirementsSubject().respond.schema, example: plannerResponse },
    { subject: { plan: 1 }, schema: planSubject(1, true).respond.schema, example: plannerResponse },
    { subject: { work: 1 }, schema: workSubject(1, true).respond.schema, example: plannerResponse },
    // W2-R1-1: a decision's response carries the amended analysis.
    { subject: { decision: 1 }, schema: decisionResponseSchema, example: { ...plannerResponse, analysis: decisionAnalysis } },
  ];
  for (const { subject, schema, example } of subjects) {
    const response = Schema.decodeUnknownSync(schema)(example);
    const message: ServerMessage = { type: "event", run: 1, seq: 0, time: T, event: responseEvent(subject, response) };
    assert.deepEqual(decoded(decodeServer(JSON.stringify(message))), plain(message), JSON.stringify(subject));
  }
});

// The audit of defect A (step 2.3 of its plan): the response type of every subject must be exactly one of the members
// the event carries. `Subject<R>` requires only `R extends PlannerResponse`, so assignability would admit a wider R;
// equality does not. Both parameters are inferred: `applyDecisions.after` takes D, so fixing D would yield never.
// A subject added to src/subjects.ts is covered once it is added to this list.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type RespondOf<T> = T extends Subject<infer R, infer _D> ? R : never;
type Carried<R> = Same<R, PlannerResponse> extends true ? true : Same<R, QuestionListResponse> extends true ? true : Same<R, DecisionResponse>;
const holds = <_T extends true>(): void => undefined;
const fails = <_T extends false>(): void => undefined;
type Responses = [RespondOf<ReturnType<typeof questionSubject>>, RespondOf<ReturnType<typeof requirementsSubject>>, RespondOf<ReturnType<typeof planSubject>>, RespondOf<ReturnType<typeof workSubject>>, RespondOf<ReturnType<typeof decisionSubject>>];
fails<Same<Responses[0], never>>();
fails<Same<Responses[1], never>>();
fails<Same<Responses[2], never>>();
fails<Same<Responses[3], never>>();
holds<Carried<Responses[0]>>();
holds<Carried<Responses[1]>>();
holds<Carried<Responses[2]>>();
holds<Carried<Responses[3]>>();
fails<Same<Responses[4], never>>();
holds<Carried<Responses[4]>>();
// The check itself refuses a response with a field the event does not carry.
fails<Carried<PlannerResponse & { extra: string }>>();

// Issue #5: Claude Code's prose travels to the page as data, attributed to Claude.
test("a ClaudeSaid event survives the round trip, live and in a replay", () => {
  const event: RunEvent = { _tag: "Notified", event: { _tag: "ClaudeSaid", text: "**done**" } };
  for (const m of [{ type: "event", run: 1, seq: 0, time: T, event }, { type: "replay", runs: [{ id: 1, events: [{ time: T, event }] }] }] as ServerMessage[]) {
    assert.deepEqual(decoded(decodeServer(JSON.stringify(m))), m);
  }
});
