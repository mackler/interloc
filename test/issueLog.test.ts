import assert from "node:assert/strict";
import { test } from "node:test";
import { appendRound, correctionsDue } from "../src/issueLog.ts";
import type { IssueId, ValidatedRound } from "../src/round.ts";

// Plan step 2.4 (P1-R1-1 of this run, rounds 1 and 2): a work review leaves for a planning phase when the round has a
// correction due: an accepted or partially accepted disposition, or an effective self-correction accepted or plan_error.
const id = (s: string) => s as IssueId;
const round = (dispositions: [string, ValidatedRound["dispositions"][number]["action"]][], self: [string, "accepted" | "rejected" | "plan_error"][] = []): ValidatedRound => ({
  phase: 1,
  round: 1,
  review: { issues: dispositions.map(([i]) => ({ id: id(i), severity: "major", location: "l", problem: "p", evidence: "e" })) },
  dispositions: dispositions.map(([i, action]) => ({ id: id(i), action, rationale: "r", duplicateOf: null, reverses: null })),
  selfCorrections: self.map(([i, newAction]) => ({ id: id(i), newAction, explanation: "x", generated: false })),
  notes: [],
  reviewerFeedback: "",
  questionsForUser: [],
});

test("correctionsDue: an accepted or partially accepted disposition", () => {
  assert.equal(correctionsDue(round([["A", "accepted"]])), true);
  assert.equal(correctionsDue(round([["A", "partially_accepted"]])), true);
  assert.equal(correctionsDue(round([["A", "rejected"], ["B", "no_change_needed"], ["C", "clarification_requested"]])), false);
});

test("correctionsDue: an accepted self-correction of an earlier issue, and a plan_error", () => {
  assert.equal(correctionsDue(round([["A", "rejected"]], [["W1-R1-1", "accepted"]])), true);
  assert.equal(correctionsDue(round([["A", "rejected"]], [["W1-R1-9", "plan_error"]])), true);
  assert.equal(correctionsDue(round([["A", "rejected"]], [["W1-R1-1", "rejected"]])), false);
});

test("correctionsDue: a self-correction superseded by the round's disposition of the same id does not count", () => {
  const overlapping = round([["X", "rejected"]], [["X", "accepted"]]);
  assert.equal(correctionsDue(overlapping), false);
  // In agreement with the log appendRound writes: the disposition's entry is the current one.
  const log = appendRound([], overlapping);
  assert.deepEqual(log.filter((e) => e.superseded !== true).map((e) => [e.id, e.action]), [["X", "rejected"]]);
});
