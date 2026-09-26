import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { advance, initialState, type ReviewCommand, type ReviewEvent, type ReviewSetup, type Transition } from "../src/reviewState.ts";
import type { Action, Review } from "../src/schema.ts";
import { issue, respond } from "./helpers.ts";

// Row 3 of the table in recommendation E of docs/functional-design-review.md: bounded generated event traces
// through `advance`, checked against a small independent model kept in the test.

const RUNS = { numRuns: 150, seed: 20260925 };
const setup: ReviewSetup = { subject: { plan: 1 }, heading: "Planning phase 1", fileLabel: "plan.md", dirName: "planning-1", phase: 1, proceed: "proceed", hasAmend: false, leaveOnAcceptance: false, leaveOnDecision: false, maxRounds: 3, maxIdleRounds: 2, countMinor: true };
const PRODUCING = new Set(["AskLimit", "AskDecision", "CallReviewer", "CallPlanner", "ApplyDecisions", "Amend", "ObserveFile", "Halt", "Finish"]);
const ACTIONS: readonly Action[] = ["accepted", "partially_accepted", "rejected", "no_change_needed", "clarification_requested"];

/** One generated round: its review, the actions of the response, whether a self-correction is included, and the world's answers. */
type Script = { issueCount: number; actions: readonly Action[]; selfCorrection: boolean; hash: string; decide: boolean; limitAnswer: "p" | "0" | "2" };
const arbScript: fc.Arbitrary<Script> = fc.record(
  {
    issueCount: fc.integer({ min: 0, max: 3 }),
    actions: fc.array(fc.constantFrom(...ACTIONS), { minLength: 3, maxLength: 3 }),
    selfCorrection: fc.boolean(),
    hash: fc.constantFrom("h1", "h2", "h3"),
    decide: fc.boolean(),
    limitAnswer: fc.constantFrom("p", "0", "2"),
  },
  { noNullPrototype: true },
);

/** Drives `advance` with scripted answers until it finishes or halts, recording what the model needs. */
const drive = (scripts: readonly Script[], use: ReviewSetup = setup) => {
  const config = { maxRounds: use.maxRounds, maxIdleRounds: use.maxIdleRounds, countMinor: true };
  let t: Transition = advance(initialState(use, config), { kind: "Begin", hash: "h0", log: [] });
  const trace: ReviewCommand[] = [...t.commands];
  const reviewerCalls: number[] = [];
  const plannerCalls: number[] = [];
  let finished: string | null = null;
  let currentRound = 0;
  for (let guard = 0; guard < 400 && finished === null; guard++) {
    const producing = t.commands.filter((c) => PRODUCING.has(c.kind));
    assert.ok(producing.length <= 1 && (producing.length === 0 || t.commands[t.commands.length - 1] === producing[0]), "a batch with a misplaced event command");
    const command: ReviewCommand | undefined = producing[0];
    if (command === undefined) throw new Error("a batch without an event command");
    // The script of the round in progress; at the limit prompt, the script of the round that would start,
    // or "0" (stop) once the scripts are used up, so that every trace ends.
    const script = scripts[Math.min(Math.max(currentRound - 1, 0), scripts.length - 1)];
    let event: ReviewEvent | null = null;
    switch (command.kind) {
      case "Halt":
      case "Finish":
        finished = command.kind === "Finish" ? command.result : command.error._tag;
        break;
      case "CallReviewer": {
        currentRound = command.round;
        reviewerCalls.push(command.round);
        const review: Review = { issues: Array.from({ length: script.issueCount }, (_, i) => issue(`R${command.round}-${i}`)) };
        event = { kind: "ReviewDecoded", review };
        break;
      }
      case "CallPlanner": {
        plannerCalls.push(command.round);
        const ids = Array.from({ length: script.issueCount }, (_, i) => `R${command.round}-${i}`);
        const response = respond(ids.map((id, i) => [id, script.actions[i]] as [string, Action]), script.selfCorrection ? { self_corrections: [{ id: "", new_action: "plan_error" as const, explanation: "e" }] } : {});
        event = { kind: "ResponseDecoded", response, resultText: "", costUsd: 0.2 };
        break;
      }
      case "AskDecision":
        event = { kind: "DecisionGiven", text: script.decide ? "do it" : "" };
        break;
      case "AskLimit":
        event = { kind: "LimitAnswer", answer: currentRound < scripts.length ? scripts[currentRound].limitAnswer : "0" };
        break;
      case "ApplyDecisions":
        event = { kind: "DecisionsApplied" };
        break;
      case "Amend":
        event = { kind: "Amended" };
        break;
      case "ObserveFile":
        event = { kind: "FileObserved", hash: script.hash };
        break;
    }
    if (event !== null) {
      t = advance(t.state, event);
      trace.push(...t.commands);
    }
  }
  return { state: t.state, finished, reviewerCalls, plannerCalls, trace };
};

test("property: the loop finishes only by convergence, an explicit proceed, or a typed halt, and every round has one reviewer call", () => {
  fc.assert(
    fc.property(fc.array(arbScript, { minLength: 1, maxLength: 8 }), (scripts) => {
      const { state, finished, reviewerCalls, plannerCalls } = drive(scripts);
      assert.notEqual(finished, null, "the loop did not end within the bound");
      assert.deepEqual(reviewerCalls, Array.from({ length: reviewerCalls.length }, (_, i) => i + 1), "rounds are consecutive from 1");
      for (const round of plannerCalls) assert.ok(reviewerCalls.includes(round), "a response without a review");
      if (finished === "converged") assert.equal(state.counts[state.counts.length - 1], 0, "converged with counted issues");
      assert.equal(state.counts.length, reviewerCalls.length, "one count per review");
      assert.ok(state.costs.length <= plannerCalls.length && state.costs.length >= plannerCalls.length - 1, "one cost per completed response");
    }),
    RUNS,
  );
});

test("property: observations keep their true round and stage, and idle follows the policy", () => {
  fc.assert(
    fc.property(fc.array(arbScript, { minLength: 1, maxLength: 8 }), (scripts) => {
      const { state } = drive(scripts);
      const rounds = state.observations.map((o) => o.round);
      assert.deepEqual(rounds, [...rounds].sort((a, b) => a - b), "observations are in round order");
      assert.equal(state.observations[0]?.round, 0);
      assert.ok(state.observations.every((o) => o.round <= state.round));
      assert.ok(state.idle >= 0 && state.idle < setup.maxIdleRounds + 1);
      // Round 0 is the start; every later round has one observation (response, or decision when a decision
      // changed the file), plus at most one more from the idle pause, which is a decision.
      assert.deepEqual(state.observations.filter((o) => o.round === 0).map((o) => o.stage), ["start"]);
      for (let r = 1; r <= state.round; r++) {
        const stages = state.observations.filter((o) => o.round === r).map((o) => o.stage);
        assert.ok(stages.length <= 2, `round ${r}: ${stages}`);
        if (stages.length === 2) assert.equal(stages[1], "decision");
        assert.ok(stages.every((s) => s !== "start"));
      }
    }),
    RUNS,
  );
});

test("property: the limit is respected — no reviewer call beyond the current limit without the user's extra rounds", () => {
  fc.assert(
    fc.property(fc.array(arbScript, { minLength: 1, maxLength: 8 }), (scripts) => {
      const { state, reviewerCalls } = drive(scripts);
      assert.ok(reviewerCalls.every((r) => r <= state.limit), `a round beyond the limit: ${reviewerCalls} > ${state.limit}`);
    }),
    RUNS,
  );
});

// Plan step 2.4: the policies of a work review. A correction due or a user decision ends the trace with
// revise; no round is logged twice; every logged checkpoint follows the response and the validated record.
const workSetup: ReviewSetup = { ...setup, subject: { work: 1 }, heading: "Work review 1", fileLabel: "changes.diff", dirName: "work-review-1", proceed: null, leaveOnAcceptance: true, leaveOnDecision: true };
test("property: a work review ends at the first correction due or decision, logs each round once, and writes only valid logged checkpoints", () => {
  fc.assert(
    fc.property(fc.array(arbScript, { minLength: 1, maxLength: 8 }), (scripts) => {
      const { finished, trace, state } = drive(scripts, workSetup);
      assert.notEqual(finished, null, "the loop did not end within the bound");
      assert.notEqual(finished, "proceed", "a work review proceeded");
      const decisions = trace.filter((c) => c.kind === "RecordDecision");
      if (decisions.length > 0) assert.equal(finished, "revise", "a decision did not end the loop");
      assert.ok(decisions.length <= 1, "the loop asked again after a decision");
      const rounds = state.log.filter((e) => e.source === "review").map((e) => `${e.phase}/${e.round}/${e.id}`);
      assert.equal(new Set(rounds).size, rounds.length, "a round is in the log twice");
      trace.forEach((c, i) => {
        if (c.kind !== "Checkpoint" || c.point.stage !== "logged") return;
        const earlier = trace.slice(0, i);
        assert.ok(earlier.some((e) => e.kind === "SaveResponse" && e.round === c.point.round), "logged without the response file");
        assert.ok(earlier.some((e) => e.kind === "SaveRound" && e.record.kind === "validated" && e.record.round === c.point.round), "logged without a validated round record");
      });
    }),
    RUNS,
  );
});
