import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import fc from "fast-check";
import { type ClientMessage, decodeClient, decodeServer, inSnapshot, type RunEvent, type RunRecord, type ServerMessage } from "../src/protocol.ts";
import type { UiEvent } from "../src/uiEvents.ts";
import { promptOf } from "../src/userPrompts.ts";
import * as prompts from "../src/prompts.ts";

// Plan step 3.1: both sides decode with the same schemas; every variant survives the JSON round trip.
const nat = fc.nat({ max: 10_000 });
const text = fc.string({ maxLength: 20 });
const subject = fc.oneof(fc.constant("questions" as const), fc.constant("requirements" as const), nat.map((plan) => ({ plan })), nat.map((work) => ({ work })));
const phase = fc.oneof(fc.constant({ kind: "questions" as const }), fc.record({ kind: fc.constantFrom("planning" as const, "execution" as const, "work" as const), n: nat }));
const agent = fc.constantFrom("claude" as const, "codex" as const);
const reviewIssue = fc.record({ id: fc.string({ minLength: 1, maxLength: 8 }), severity: fc.constantFrom("blocking" as const, "major" as const, "minor" as const), location: text, problem: text, evidence: text });
const review = fc.record({ issues: fc.array(reviewIssue, { maxLength: 3 }) });
const disposition = fc.record({ id: text, action: fc.constantFrom("accepted" as const, "rejected" as const, "partially_accepted" as const, "no_change_needed" as const, "clarification_requested" as const), rationale: text, duplicate_of: text, reverses: text });
const response = fc.record({
  dispositions: fc.array(disposition, { maxLength: 3 }),
  self_corrections: fc.array(fc.record({ id: text, new_action: fc.constantFrom("accepted" as const, "rejected" as const, "plan_error" as const), explanation: text }), { maxLength: 2 }),
  reviewer_feedback: text,
  questions_for_user: fc.array(text, { maxLength: 2 }),
});
const outcome = fc.record({ status: fc.constantFrom("finished" as const, "needs_input" as const, "blocked" as const, "aborted" as const), summary: text, question: text, remainingWork: text, userInput: fc.option(text, { nil: null }) });
const uiEvent: fc.Arbitrary<UiEvent> = fc.oneof(
  phase.map((p) => ({ _tag: "PhaseBegan" as const, phase: p })),
  fc.record({ _tag: fc.constant("PhaseEnded" as const), phase, result: text }),
  fc.record({ _tag: fc.constant("RoundBegan" as const), subject, round: nat, limit: nat }),
  fc.record({ _tag: fc.constant("ReviewReceived" as const), subject, round: nat, review, counted: nat }),
  fc.record({ _tag: fc.constant("ResponseReceived" as const), subject, round: nat, response, resultText: text }),
  fc.record({ _tag: fc.constant("LoopFinished" as const), subject, result: fc.constantFrom("converged" as const, "proceed" as const, "revise" as const) }),
  fc.record({ _tag: fc.constant("PlanWritten" as const), phase: nat, questions: fc.array(text, { maxLength: 2 }), resultText: text }),
  fc.record({ _tag: fc.constant("ExecutionEnded" as const), phase: nat, outcome }),
  fc.record({ _tag: fc.constant("AgentCallStarted" as const), agent, purpose: text }),
  fc.record({ _tag: fc.constant("ToolUsed" as const), agent, tool: text, target: text }),
  fc.record({ _tag: fc.constant("AgentCallEnded" as const), agent, ok: fc.boolean() }),
  fc.record({ _tag: fc.constant("QuestionAsked" as const), question: text, options: fc.array(fc.record({ label: text, description: text }), { maxLength: 3 }) }),
  fc.record({ _tag: fc.constant("InterviewTurn" as const), heading: text, message: text, summary: fc.option(text, { nil: null }) }),
  fc.record({ _tag: fc.constant("InterviewOpened" as const), heading: text }),
);
const promptTexts = [prompts.decisionPrompt("x"), prompts.limitPrompt(3, "go"), prompts.permissionPrompt, prompts.interviewMessagePrompt, "unknown > "];
const runEvent: fc.Arbitrary<RunEvent> = fc.oneof(
  fc.record({ _tag: fc.constant("Started" as const), project: text, task: text, time: text }),
  fc.record({ _tag: fc.constant("Said" as const), text }),
  fc.tuple(nat, fc.constantFrom(...promptTexts)).map(([prompt, t]): RunEvent => ({ _tag: "Asked", prompt, ...promptOf(t) })),
  fc.record({ _tag: fc.constant("Answered" as const), prompt: nat, text }),
  uiEvent.map((event) => ({ _tag: "Notified" as const, event })),
  fc.record({ _tag: fc.constant("Ended" as const), code: fc.constantFrom(0, 1, 2, 130) }),
);
const runRecord: fc.Arbitrary<RunRecord> = fc.record({ id: nat, events: fc.array(runEvent, { maxLength: 4 }) });
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
  fc.record({ type: fc.constant("event" as const), run: nat, seq: nat, event: runEvent }),
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

// P1-R1-2 (both rounds): the boundary is kept for every replayed run.
const position = fc.record({ run: fc.nat({ max: 5 }), seq: fc.nat({ max: 60 }) });
const replayed = fc.uniqueArray(fc.record({ id: fc.nat({ max: 5 }), count: fc.nat({ max: 60 }) }), { selector: (r) => r.id, maxLength: 2 }).map((rs) => rs.map((r): RunRecord => ({ id: r.id, events: Array.from({ length: r.count }, () => ({ _tag: "Said" as const, text: "" })) })));

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
  const a: RunRecord = { id: 1, events: Array.from({ length: 50 }, () => ({ _tag: "Said" as const, text: "" })) };
  assert.equal(inSnapshot([a], { run: 2, seq: 0 }), false);
  assert.equal(inSnapshot([a], { run: 1, seq: 49 }), true);
  assert.equal(inSnapshot([a], { run: 1, seq: 50 }), false);
});
