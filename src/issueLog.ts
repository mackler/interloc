// Pure functions on the issue log. No file access and no agent calls.

import type { LogEntry, PlannerResponse, Review } from "./schema.ts";

const NOT_ACCEPTED_IN_FULL = new Set(["rejected", "partially_accepted", "no_change_needed"]);

function current(log: LogEntry[]): LogEntry[] {
  return log.filter((e) => e.superseded !== true);
}

/** Ids in the review that Claude Code did not accept in full earlier and that Codex has raised again. */
export function reraisedIds(log: LogEntry[], review: Review): string[] {
  const open = new Set(current(log).filter((e) => NOT_ACCEPTED_IN_FULL.has(e.action)).map((e) => e.id));
  return review.issues.map((i) => i.id).filter((id) => open.has(id));
}

/** Pairs [new id, earlier id]: issues that Claude Code identifies as repetitions of an issue not accepted in full. */
export function repeatedUnderNewId(log: LogEntry[], response: PlannerResponse): [string, string][] {
  const open = new Set(current(log).filter((e) => NOT_ACCEPTED_IN_FULL.has(e.action)).map((e) => e.id));
  return response.dispositions
    .filter((d) => d.duplicate_of !== "" && d.duplicate_of !== d.id && open.has(d.duplicate_of))
    .map((d) => [d.id, d.duplicate_of]);
}

/** Pairs [new id, earlier id]: issues whose correction would undo an earlier accepted correction. */
export function reversals(response: PlannerResponse): [string, string][] {
  return response.dispositions.filter((d) => d.reverses !== "").map((d) => [d.id, d.reverses]);
}

/** Ids for which Claude Code requests clarification and has requested it before. */
export function secondClarifications(log: LogEntry[], response: PlannerResponse): string[] {
  const asked = new Set(log.filter((e) => e.action === "clarification_requested").map((e) => e.id));
  return response.dispositions.filter((d) => d.action === "clarification_requested" && asked.has(d.id)).map((d) => d.id);
}

/** Issue ids of the review that have no disposition. */
const duplicates = (ids: readonly string[]): string[] => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];

/** Structural problems of a review, checked before anything is done with it: an id that appears more than once. */
export function reviewProblems(review: Review): { duplicateIssues: string[] } {
  return { duplicateIssues: duplicates(review.issues.map((i) => i.id)) };
}

/**
 * Structural problems of a response against its review: an issue without a disposition, an id with more than
 * one disposition, and a disposition for an id that is not in the review. Any of them makes the round invalid.
 */
export function roundProblems(review: Review, response: PlannerResponse): { missing: string[]; duplicateDispositions: string[]; unknownDispositions: string[] } {
  const issueIds = new Set(review.issues.map((i) => i.id));
  const dispositionIds = response.dispositions.map((d) => d.id);
  return {
    missing: missingDispositions(review, response),
    duplicateDispositions: duplicates(dispositionIds),
    unknownDispositions: [...new Set(dispositionIds.filter((id) => !issueIds.has(id)))],
  };
}

export function missingDispositions(review: Review, response: PlannerResponse): string[] {
  const answered = new Set(response.dispositions.map((d) => d.id));
  return review.issues.map((i) => i.id).filter((id) => !answered.has(id));
}

export function acceptedCount(response: PlannerResponse): number {
  return response.dispositions.filter((d) => d.action === "accepted" || d.action === "partially_accepted").length;
}

function supersede(log: LogEntry[], ids: Set<string>): LogEntry[] {
  return log.map((e) => (ids.has(e.id) ? { ...e, superseded: true } : e));
}

/** Returns the log with the entries of one round appended. Earlier entries with the same id are marked superseded. */
export function appendRound(log: LogEntry[], review: Review, response: PlannerResponse, phase: number, round: number): LogEntry[] {
  const fromReview: LogEntry[] = review.issues.map((issue) => {
    const d = response.dispositions.find((x) => x.id === issue.id);
    if (!d) throw new Error(`no disposition for issue ${issue.id}`);
    return { ...issue, ...d, phase, round, source: "review" };
  });
  const fromSelf: LogEntry[] = response.self_corrections.map((sc, k) => {
    const earlier = log.filter((e) => e.id === sc.id).at(-1);
    return {
      id: sc.id === "" ? `P${phase}-S${round}-${k + 1}` : sc.id,
      phase,
      round,
      source: "self_correction",
      problem: earlier?.problem ?? "error found by the planner",
      action: sc.new_action === "rejected" ? "correction_disputed" : sc.new_action,
      rationale: sc.explanation,
    };
  });
  const added = [...fromReview, ...fromSelf];
  return [...supersede(log, new Set(added.map((e) => e.id))), ...added];
}

/** Returns the log with a decision of the user on one issue appended. */
export function appendUserDecision(log: LogEntry[], id: string, decision: string, phase: number, round: number): LogEntry[] {
  const earlier = log.filter((e) => e.id === id).at(-1);
  const entry: LogEntry = {
    id,
    phase,
    round,
    source: "user",
    problem: earlier?.problem ?? "",
    action: "decided_by_user",
    rationale: decision,
  };
  return [...supersede(log, new Set([id])), entry];
}

export function countedIssues(review: Review, countMinor: boolean): number {
  return countMinor ? review.issues.length : review.issues.filter((i) => i.severity !== "minor").length;
}
