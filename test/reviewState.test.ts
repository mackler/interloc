import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunError } from "../src/errors.ts";
import { describe } from "../src/errors.ts";
import { advance, initialState, type ReviewCommand, type ReviewEvent, type ReviewSetup, type ReviewState, type Transition } from "../src/reviewState.ts";
import type { LogEntry } from "../src/schema.ts";
import { issue, respond } from "./helpers.ts";

// Finding 13 (and 14, 15) of docs/functional-design-review.md; decision Q7: the review loop as a pure
// state machine. The scenario tests of test/run.test.ts remain the behavioural specification; these
// examples pin each transition.

const setup: ReviewSetup = { heading: "Planning phase 1", fileLabel: "plan.md", dirName: "planning-1", phase: 1, proceedLabel: "proceed to execution with the plan as it is", hasAmend: false, maxRounds: 5, maxIdleRounds: 2, countMinor: true };
const start = (config: Partial<{ maxRounds: number; maxIdleRounds: number; countMinor: boolean }> = {}, log: LogEntry[] = []): Transition =>
  advance(initialState(setup, { maxRounds: 5, maxIdleRounds: 2, countMinor: true, ...config }), { kind: "Begin", hash: "h0", log });
const kinds = (t: Transition): string[] => t.commands.map((c) => c.kind);
const last = (t: Transition): ReviewCommand => t.commands[t.commands.length - 1];
const says = (t: Transition): string => t.commands.flatMap((c) => (c.kind === "Say" ? [c.text] : [])).join("\n");
const halt = (t: Transition): RunError => {
  const c = last(t);
  assert.equal(c.kind, "Halt", `expected Halt, got ${kinds(t).join(",")}`);
  return (c as { error: RunError }).error;
};
/** Applies the events in order, returning the last transition. */
const run = (first: Transition, ...events: ReviewEvent[]): Transition => events.reduce((t, e) => advance(t.state, e), first);
const noQuestions = { questions_for_user: [] };
const entry = (id: string, action: string, round = 1): LogEntry =>
  ({ id, phase: 1, round, source: "review", severity: "major", location: "l", problem: "p", evidence: "e", action, rationale: "r", duplicate_of: null, reverses: null, superseded: false }) as LogEntry;
const response = (dispositions: [string, "accepted" | "rejected" | "partially_accepted" | "no_change_needed" | "clarification_requested"][], extra = {}): ReviewEvent => ({ kind: "ResponseDecoded", response: respond(dispositions, extra), resultText: "", costUsd: 0.1 });
void noQuestions;

test("Begin: round 1 starts with the Codex review and the initial observation is recorded", () => {
  const t = start();
  assert.match(says(t), /round 1 \(limit 5\): Codex review/);
  assert.deepEqual(last(t), { kind: "CallReviewer", round: 1 });
  assert.deepEqual(t.state.observations, [{ round: 0, stage: "start", hash: "h0" }]);
  assert.equal(t.state.round, 1);
});

test("a review with no counted issue converges; with countMinor off, minor issues do not count", () => {
  const t = run(start(), { kind: "ReviewDecoded", review: { issues: [] } });
  assert.deepEqual(kinds(t).slice(-2), ["Converse", "Finish"]);
  assert.deepEqual(last(t), { kind: "Finish", result: "converged" });
  assert.deepEqual(t.state.counts, [0]);
  const minor = run(start({ countMinor: false }), { kind: "ReviewDecoded", review: { issues: [{ ...issue("A"), severity: "minor" }] } });
  assert.deepEqual(last(minor), { kind: "Finish", result: "converged" });
});

test("a review with duplicate ids halts before anything is counted", () => {
  const t = run(start(), { kind: "ReviewDecoded", review: { issues: [issue("A"), issue("A")] } });
  assert.equal(halt(t)._tag, "RoundInvalid");
  assert.deepEqual(t.state.counts, []);
});

test("a counted review saves the review, reports the count, and asks about each reraised id before the response", () => {
  const t = run(start({}, [entry("A", "rejected")]), { kind: "ReviewDecoded", review: { issues: [issue("A"), issue("B")] } });
  assert.ok(kinds(t).includes("SaveReview"));
  assert.match(says(t), /Issues: 2 total, 2 counted/);
  assert.match(says(t), /raised again/);
  assert.deepEqual(last(t), { kind: "AskDecision", subject: "issue A, raised again after Claude Code did not accept it in full", id: "A" });
  const kept = advance(t.state, { kind: "DecisionGiven", text: "keep the rejection" });
  assert.equal(kept.commands[0].kind, "RecordDecision");
  assert.deepEqual(last(kept), { kind: "CallPlanner", round: 1 });
  const silent = advance(t.state, { kind: "DecisionGiven", text: "" });
  assert.ok(!kinds(silent).includes("RecordDecision"));
  assert.deepEqual(last(silent), { kind: "CallPlanner", round: 1 });
});

const afterReview = (log: LogEntry[] = [], issues = [issue("A")]): Transition => run(start({}, log), { kind: "ReviewDecoded", review: { issues } });

test("an invalid response halts; a valid one is saved, rendered, and the round goes to the log and the file is observed", () => {
  const invalid = run(afterReview(), response([["A", "accepted"], ["A", "rejected"]]));
  assert.equal(halt(invalid)._tag, "RoundInvalid");
  const valid = run(afterReview(), response([["A", "accepted"]]));
  assert.deepEqual(kinds(valid).filter((k) => k !== "Say"), ["SaveResponse", "SaveRound", "Converse", "SaveLog", "ObserveFile"]);
  assert.deepEqual(last(valid), { kind: "ObserveFile", stage: "response" });
  assert.equal(valid.state.log.length, 1);
  assert.equal(valid.state.log[0].action, "accepted");
  assert.deepEqual(valid.state.costs, [0.1]);
});

test("reviewer feedback is recorded, and a dropped reference is noted", () => {
  const t = run(afterReview([entry("Z", "rejected")]), response([["A", "rejected"]], { reviewer_feedback: "too strict" }));
  assert.ok(t.commands.some((c) => c.kind === "RecordFeedback" && c.text === "too strict"));
  const withRef = { kind: "ResponseDecoded", response: { ...respond([["A", "rejected"]]), dispositions: [{ ...respond([["A", "rejected"]]).dispositions[0], reverses: "Q" }] }, resultText: "", costUsd: null } as const;
  const noted = run(afterReview(), withRef);
  assert.ok(noted.commands.some((c) => c.kind === "Converse" && /Reference dropped/.test(c.markdown)));
});

test("accepted without a change of the file halts", () => {
  const t = run(afterReview(), response([["A", "accepted"]]), { kind: "FileObserved", hash: "h0" });
  const error = halt(t);
  assert.equal(error._tag, "AcceptedWithoutChange");
  assert.match(describe(error), /plan\.md is unchanged/);
});

test("the pauses ask in the decided order and a decision leads to ApplyDecisions before the log", () => {
  const log = [entry("C", "accepted"), entry("O", "rejected")];
  const dispositions = respond([["A", "clarification_requested"], ["B", "rejected"], ["N", "rejected"]]).dispositions.map((d) => (d.id === "B" ? { ...d, reverses: "C" } : d.id === "N" ? { ...d, duplicate_of: "O" } : d));
  const resp = { ...respond([]), dispositions, self_corrections: [{ id: "C", new_action: "rejected" as const, explanation: "x" }], questions_for_user: ["Which?"] };
  const t = run(afterReview([...log, entry("A", "clarification_requested")], [issue("A"), issue("B"), issue("N")]), { kind: "ResponseDecoded", response: resp, resultText: "", costUsd: null });
  const subjects: string[] = [];
  let step = t;
  while (last(step).kind === "AskDecision") {
    subjects.push((last(step) as { subject: string }).subject);
    step = advance(step.state, { kind: "DecisionGiven", text: subjects.length === 1 ? "answer" : "" });
  }
  assert.deepEqual(subjects.map((s) => s.split(",")[0].split(" against")[0]), ["issue A", "the accepted correction for C", "issue B", "issue N", "question from Claude Code: Which?"]);
  assert.deepEqual(last(step), { kind: "ApplyDecisions" });
  const applied = advance(step.state, { kind: "DecisionsApplied" });
  assert.deepEqual(kinds(applied), ["SaveLog", "ObserveFile"]);
  assert.equal(applied.state.log.filter((e) => e.action === "decided_by_user").length, 1);
});

test("an unexplained change asks; no decision leads on, a decision applies and observes again", () => {
  const t = run(afterReview(), response([["A", "rejected"]]), { kind: "FileObserved", hash: "h1" });
  assert.match(says(t), /changed in round 1 without an accepted issue/);
  assert.equal(last(t).kind, "AskDecision");
  const onward = advance(t.state, { kind: "DecisionGiven", text: "" });
  assert.deepEqual(last(onward), { kind: "CallReviewer", round: 2 });
  assert.deepEqual(onward.state.observations.at(-1), { round: 1, stage: "response", hash: "h1" });
  assert.equal(onward.state.idle, 1);
  const applying = advance(t.state, { kind: "DecisionGiven", text: "fix it" });
  assert.deepEqual(last(applying), { kind: "ApplyDecisions" });
  const observing = advance(applying.state, { kind: "DecisionsApplied" });
  assert.deepEqual(last(observing), { kind: "ObserveFile", stage: "decision" });
  const done = advance(observing.state, { kind: "FileObserved", hash: "h2" });
  assert.deepEqual(done.state.observations.at(-1), { round: 1, stage: "decision", hash: "h2" });
});

test("identical content names the round after which it was seen, with the decision stage", () => {
  const t = run(afterReview(), response([["A", "rejected"]]), { kind: "FileObserved", hash: "h1" }, { kind: "DecisionGiven", text: "" });
  const round2 = run(t, { kind: "ReviewDecoded", review: { issues: [issue("B")] } }, response([["B", "rejected"]]), { kind: "FileObserved", hash: "h0" }, { kind: "DecisionGiven", text: "" });
  assert.match(says(round2), /after round 2 is identical to plan\.md after round 0/);
  assert.equal(last(round2).kind, "AskDecision");
});

test("idle rounds: the prompt after maxIdleRounds, a decision applies and is observed as a decision stage, and the counter resets", () => {
  const t = run(afterReview(), { kind: "ResponseDecoded", response: respond([["A", "rejected"]]), resultText: "", costUsd: null }, { kind: "FileObserved", hash: "h0" });
  const idle = run(start({ maxIdleRounds: 1 }), { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "rejected"]]), { kind: "FileObserved", hash: "h0" });
  assert.match(says(idle), /accepted no issue in 1 consecutive rounds/);
  assert.equal(last(idle).kind, "AskDecision");
  const applied = run(idle, { kind: "DecisionGiven", text: "apply" }, { kind: "DecisionsApplied" });
  assert.deepEqual(last(applied), { kind: "ObserveFile", stage: "decision" });
  const next = advance(applied.state, { kind: "FileObserved", hash: "h5" });
  assert.deepEqual(next.state.observations.at(-1), { round: 1, stage: "decision", hash: "h5" });
  assert.equal(next.state.idle, 0);
  assert.deepEqual(last(next), { kind: "CallReviewer", round: 2 });
  assert.equal(t.state.idle, 1);
});

test("the round limit: proceed, stop, or more rounds", () => {
  const atLimit = run(start({ maxRounds: 1 }), { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "rejected"]]), { kind: "FileObserved", hash: "h0" });
  assert.deepEqual(last(atLimit), { kind: "AskLimit", limit: 1 });
  assert.match(says(atLimit), /round 1: counted issues = 1, total_cost_usd = 0.1/);
  const proceed = advance(atLimit.state, { kind: "LimitAnswer", answer: "p" });
  assert.deepEqual(last(proceed), { kind: "Finish", result: "proceed" });
  assert.ok(proceed.commands.some((c) => c.kind === "Converse" && /without convergence after round 1/.test(c.markdown)));
  assert.equal(halt(advance(atLimit.state, { kind: "LimitAnswer", answer: "0" }))._tag, "RoundLimitStop");
  const more = advance(atLimit.state, { kind: "LimitAnswer", answer: "3" });
  assert.equal(more.state.limit, 4);
  assert.deepEqual(last(more), { kind: "CallReviewer", round: 2 });
});

test("amend runs between the pauses and the log when the subject has one", () => {
  const withAmend = advance(initialState({ ...setup, hasAmend: true }, { maxRounds: 5, maxIdleRounds: 2, countMinor: true }), { kind: "Begin", hash: "h0", log: [] });
  const t = run(withAmend, { kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "accepted"]]));
  assert.deepEqual(last(t), { kind: "Amend", round: 1 });
  const amended = advance(t.state, { kind: "Amended" });
  assert.deepEqual(kinds(amended), ["SaveLog", "ObserveFile"]);
});

test("every batch has at most one event-producing command, and it is the last", () => {
  const producing = new Set(["AskLimit", "AskDecision", "CallReviewer", "CallPlanner", "ApplyDecisions", "Amend", "ObserveFile", "Halt", "Finish"]);
  const check = (t: Transition): void => {
    const positions = t.commands.flatMap((c, i) => (producing.has(c.kind) ? [i] : []));
    assert.ok(positions.length <= 1 && (positions.length === 0 || positions[0] === t.commands.length - 1), kinds(t).join(","));
  };
  let t = start({ maxIdleRounds: 1 });
  check(t);
  for (const e of [{ kind: "ReviewDecoded", review: { issues: [issue("A")] } }, response([["A", "rejected"]]), { kind: "FileObserved", hash: "h1" }, { kind: "DecisionGiven", text: "" }, { kind: "DecisionGiven", text: "" }] as ReviewEvent[]) {
    t = advance(t.state, e);
    check(t);
  }
  const state: ReviewState = t.state;
  assert.equal(state.round, 2);
});

// Q5: the round record is written from the validated values: no_response with the review, validated with the response.
test("the round record is saved as no_response after the review and as validated after the response", () => {
  const rounds = (t: Transition) => t.commands.flatMap((c) => (c.kind === "SaveRound" ? [c.record] : []));
  const afterReviewT = afterReview();
  const [noResponse] = rounds(afterReviewT);
  assert.equal(noResponse?.kind, "no_response");
  assert.deepEqual([noResponse?.subject, noResponse?.phase, noResponse?.round, noResponse?.reconstructed], ["planning-1", 1, 1, false]);
  const converged = run(start(), { kind: "ReviewDecoded", review: { issues: [] } });
  assert.equal(rounds(converged)[0]?.kind, "no_response");
  const [validated] = rounds(run(afterReviewT, response([["A", "accepted"]])));
  assert.equal(validated?.kind, "validated");
  if (validated?.kind !== "validated") return;
  assert.deepEqual(validated.response.dispositions.map((d) => [d.id, d.action]), [["A", "accepted"]]);
  assert.deepEqual(validated.review.issues.map((i) => i.id), ["A"]);
  assert.equal(validated.reconstructed, false);
});
