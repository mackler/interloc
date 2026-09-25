// The review loop as a pure state machine (finding 13 of docs/functional-design-review.md; decision Q7):
// `advance(state, event)` returns the next state and the commands to execute. The interpreter in
// src/review.ts executes the commands against the services and feeds each result back as the next event.
// The pause order of decided behaviour 7 is the order of the steps below. No I/O, no Effect.

import { AcceptedWithoutChange, RoundLimitStop, type RunError } from "./errors.ts";
import { parseExtraRounds } from "./input.ts";
import * as log from "./issueLog.ts";
import { renderRound } from "./render.ts";
import { type IssueId, validateReview, validateRound, type ValidatedReview, type ValidatedRound } from "./round.ts";
import type { CheckpointPoint, RoundRecord } from "./records.ts";
import type { Config, LogEntry, PlannerResponse, Review } from "./schema.ts";
import { Result } from "effect";

export type Stage = "start" | "response" | "decision";
export type Observation = Readonly<{ round: number; stage: Stage; hash: string }>;
/** The one typed decision of the user (finding 15): the issue log entry and the record lines both derive from it. */
export type DecisionEvent = Readonly<{ subject: string; id: IssueId | null; decision: string; phase: number; round: number }>;

/** What the loop asks the interpreter to do. A batch ends with at most one command that yields an event. */
export type ReviewCommand =
  | Readonly<{ kind: "Say"; text: string }>
  | Readonly<{ kind: "Converse"; markdown: string }>
  | Readonly<{ kind: "RecordDecision"; decision: DecisionEvent }>
  | Readonly<{ kind: "RecordFeedback"; round: number; text: string }>
  | Readonly<{ kind: "SaveReview"; round: number; review: Review }>
  | Readonly<{ kind: "SaveResponse"; round: number; response: PlannerResponse }>
  | Readonly<{ kind: "SaveLog"; log: readonly LogEntry[] }>
  | Readonly<{ kind: "SaveRound"; record: RoundRecord }>
  | Readonly<{ kind: "Checkpoint"; point: CheckpointPoint }>
  | Readonly<{ kind: "AskLimit"; limit: number }>
  | Readonly<{ kind: "AskDecision"; subject: string; id: IssueId | null }>
  | Readonly<{ kind: "CallReviewer"; round: number }>
  | Readonly<{ kind: "CallPlanner"; round: number }>
  | Readonly<{ kind: "ApplyDecisions" }>
  | Readonly<{ kind: "Amend"; round: number }>
  | Readonly<{ kind: "ObserveFile"; stage: Stage }>
  | Readonly<{ kind: "Halt"; error: RunError }>
  | Readonly<{ kind: "Finish"; result: "converged" | "proceed" }>;

/** What the world reports back. */
export type ReviewEvent =
  | Readonly<{ kind: "Begin"; hash: string; log: readonly LogEntry[] }>
  | Readonly<{ kind: "LimitAnswer"; answer: string }>
  | Readonly<{ kind: "ReviewDecoded"; review: Review }>
  | Readonly<{ kind: "ResponseDecoded"; response: PlannerResponse; resultText: string; costUsd: number | null }>
  | Readonly<{ kind: "DecisionGiven"; text: string }>
  | Readonly<{ kind: "DecisionsApplied" }>
  | Readonly<{ kind: "Amended" }>
  | Readonly<{ kind: "FileObserved"; hash: string }>;

/** What the loop is set up with: the subject's names and the configuration. */
export type ReviewSetup = Readonly<{
  heading: string;
  fileLabel: string;
  /** The subject directory under plan-review/, recorded in the round records. */
  dirName: string;
  phase: number;
  proceedLabel: string;
  hasAmend: boolean;
  maxRounds: number;
  maxIdleRounds: number;
  countMinor: boolean;
}>;

type Ask = Readonly<{ say: readonly string[]; subject: string; id: IssueId | null }>;
/** Where the loop is inside a round: what the next event means. */
export type Step =
  | Readonly<{ name: "idle" }>
  | Readonly<{ name: "awaitingLimit" }>
  | Readonly<{ name: "awaitingReview" }>
  | Readonly<{ name: "askingReraised"; asking: Ask; queue: readonly Ask[] }>
  | Readonly<{ name: "awaitingResponse" }>
  | Readonly<{ name: "askingPauses"; asking: Ask; queue: readonly Ask[] }>
  | Readonly<{ name: "applyingPauseDecisions" }>
  | Readonly<{ name: "amending" }>
  | Readonly<{ name: "observingResponse" }>
  | Readonly<{ name: "askingUnexplained"; asking: Ask; hash: string }>
  | Readonly<{ name: "applyingUnexplained" }>
  | Readonly<{ name: "observingUnexplained" }>
  | Readonly<{ name: "askingIdentical"; asking: Ask; hash: string; stage: Stage }>
  | Readonly<{ name: "applyingIdentical" }>
  | Readonly<{ name: "observingIdentical" }>
  | Readonly<{ name: "askingIdle"; asking: Ask }>
  | Readonly<{ name: "applyingIdle" }>
  | Readonly<{ name: "observingIdle" }>
  | Readonly<{ name: "finished" }>;

/** The data of the round in progress. */
export type RoundInProgress = Readonly<{
  review: Review | null;
  validatedReview: ValidatedReview | null;
  round: ValidatedRound | null;
  response: PlannerResponse | null;
  resultText: string;
  decided: boolean;
  decisions: readonly DecisionEvent[];
}>;

export type ReviewState = Readonly<{
  setup: ReviewSetup;
  step: Step;
  round: number;
  limit: number;
  idle: number;
  log: readonly LogEntry[];
  observations: readonly Observation[];
  counts: readonly number[];
  costs: readonly (number | null)[];
  current: RoundInProgress;
}>;

export type Transition = Readonly<{ state: ReviewState; commands: readonly ReviewCommand[] }>;

const freshRound: RoundInProgress = { review: null, validatedReview: null, round: null, response: null, resultText: "", decided: false, decisions: [] };

export const initialState = (setup: ReviewSetup, config: Pick<Config, "maxRounds" | "maxIdleRounds" | "countMinor">): ReviewState => ({
  setup: { ...setup, maxRounds: config.maxRounds, maxIdleRounds: config.maxIdleRounds, countMinor: config.countMinor },
  step: { name: "idle" },
  round: 0,
  limit: config.maxRounds,
  idle: 0,
  log: [],
  observations: [],
  counts: [],
  costs: [],
  current: freshRound,
});

// ---- rendering ----------------------------------------------------------------------------------

const say = (text: string): ReviewCommand => ({ kind: "Say", text });
const show = (value: unknown): string => JSON.stringify(value, null, 2);
const describeObservation = (o: Observation): string => (o.stage === "decision" ? `round ${o.round} (after the user's decision)` : `round ${o.round}`);

// ---- transitions --------------------------------------------------------------------------------

const done = (state: ReviewState, command: ReviewCommand, before: readonly ReviewCommand[] = []): Transition => ({ state: { ...state, step: { name: "finished" } }, commands: [...before, command] });
const halt = (state: ReviewState, error: RunError): Transition => done(state, { kind: "Halt", error });
const noop = (state: ReviewState): Transition => ({ state, commands: [] });
const decisionOf = (s: ReviewState, ask: Ask, text: string): DecisionEvent => ({ subject: ask.subject, id: ask.id, decision: text, phase: s.setup.phase, round: s.round });
/** The checkpoint of the transition just committed (Q6): after the last record of its batch. */
const checkpoint = (s: ReviewState, stage: CheckpointPoint["stage"]): ReviewCommand => ({ kind: "Checkpoint", point: { subject: s.setup.dirName, phase: s.setup.phase, round: s.round, stage } });
/** A decision is recorded and is a committed transition of its own. */
const record = (s: ReviewState, d: DecisionEvent): readonly ReviewCommand[] => [{ kind: "RecordDecision", decision: d }, checkpoint(s, "decided")];
const ask = (s: ReviewState, step: Step, asking: Ask, before: readonly ReviewCommand[] = []): Transition => ({
  state: { ...s, step },
  commands: [...before, ...asking.say.map(say), { kind: "AskDecision", subject: asking.subject, id: asking.id }],
});

/** Round n + 1 begins: the limit prompt if the limit is reached, otherwise the Codex review. */
const startRound = (s: ReviewState): Transition => {
  const { heading, proceedLabel } = s.setup;
  const n = s.round + 1;
  if (n > s.limit) {
    void proceedLabel;
    const lines = [`\nCounted issues and reported Claude Code usage per round of ${heading}:`, ...s.counts.map((c, i) => `  round ${i + 1}: counted issues = ${c}, total_cost_usd = ${s.costs[i] ?? "not reported"}`)];
    return { state: { ...s, step: { name: "awaitingLimit" } }, commands: [...lines.map(say), { kind: "AskLimit", limit: s.limit }] };
  }
  return {
    state: { ...s, round: n, step: { name: "awaitingReview" }, current: freshRound },
    commands: [say(`\n${heading}, round ${n} (limit ${s.limit}): Codex review ...`), { kind: "CallReviewer", round: n }],
  };
};

const onLimitAnswer = (s: ReviewState, answer: string): Transition => {
  const { heading, proceedLabel } = s.setup;
  if (answer === "p") {
    return done(s, { kind: "Finish", result: "proceed" }, [{ kind: "Converse", markdown: `**User decision:** ${proceedLabel} without convergence after round ${s.round} of ${heading}.\n\n` }]);
  }
  const added = parseExtraRounds(answer);
  if (added === null) return halt(s, new RoundLimitStop({ heading }));
  return startRound({ ...s, limit: s.limit + added });
};

/** After the reraised prompts: the planner's response. */
const toResponse = (s: ReviewState, before: readonly ReviewCommand[] = []): Transition => ({
  state: { ...s, step: { name: "awaitingResponse" } },
  commands: [...before, say(`${s.setup.heading}, round ${s.round}: Claude Code response ...`), { kind: "CallPlanner", round: s.round }],
});

const askEach = (s: ReviewState, queue: readonly Ask[], step: (asking: Ask, rest: readonly Ask[]) => Step, otherwise: (s: ReviewState, before: readonly ReviewCommand[]) => Transition, before: readonly ReviewCommand[] = []): Transition => {
  if (queue.length === 0) return otherwise(s, before);
  const [asking, ...rest] = queue;
  return ask(s, step(asking, rest), asking, before);
};

const onReviewDecoded = (s: ReviewState, review: Review): Transition => {
  const { heading, fileLabel, countMinor } = s.setup;
  const n = s.round;
  const checked = validateReview(review);
  if (Result.isFailure(checked)) return halt(s, checked.failure);
  const counted = log.countedIssues(review, countMinor);
  const state: ReviewState = { ...s, counts: [...s.counts, counted], current: { ...freshRound, review, validatedReview: checked.success } };
  const before: ReviewCommand[] = [
    { kind: "SaveReview", round: n, review },
    { kind: "SaveRound", record: { kind: "no_response", subject: s.setup.dirName, phase: s.setup.phase, round: n, reconstructed: false, review: checked.success } },
    say(`Issues: ${review.issues.length} total, ${counted} counted toward convergence.`),
  ];
  if (counted === 0) {
    return done(state, { kind: "Finish", result: "converged" }, [...before, { kind: "Converse", markdown: `## ${heading}, round ${n}\n\n### Codex\n\nNo counted issue. The review of ${fileLabel} has converged.\n\n` }, checkpoint(state, "reviewed")]);
  }
  const reraised: Ask[] = log.reraisedIds(s.log, review).map((id) => ({
    say: [`\nCodex has raised again an issue that Claude Code did not accept in full:`, show(s.log.filter((e) => e.id === id)), show(review.issues.find((i) => i.id === id))],
    subject: `issue ${id}, raised again after Claude Code did not accept it in full`,
    id: id as IssueId,
  }));
  return askEach(state, reraised, (asking, queue) => ({ name: "askingReraised", asking, queue }), toResponse, [...before, checkpoint(state, "reviewed")]);
};

const onResponseDecoded = (s: ReviewState, response: PlannerResponse, resultText: string, costUsd: number | null): Transition => {
  const { heading, phase } = s.setup;
  const n = s.round;
  const review = s.current.review!;
  const checked = validateRound(s.current.validatedReview!, response, s.log, phase, n);
  const withCost: ReviewState = { ...s, costs: [...s.costs, costUsd] };
  if (Result.isFailure(checked)) return halt(withCost, checked.failure);
  const round = checked.success;
  const state: ReviewState = { ...withCost, current: { ...s.current, round, response, resultText } };
  const before: ReviewCommand[] = [
    { kind: "SaveResponse", round: n, response },
    {
      kind: "SaveRound",
      record: {
        kind: "validated",
        subject: s.setup.dirName,
        phase,
        round: n,
        reconstructed: false,
        review: round.review,
        response: { dispositions: round.dispositions, selfCorrections: round.selfCorrections, reviewerFeedback: round.reviewerFeedback, questionsForUser: round.questionsForUser },
        notes: round.notes,
      },
    },
    { kind: "Converse", markdown: renderRound(heading, n, review, response) },
    ...round.notes.map((note): ReviewCommand => {
      const why = note.reason === "unknown" ? "names no current entry of the issue log" : "names an issue whose current disposition is not an accepted correction";
      return { kind: "Converse", markdown: `**Reference dropped:** ${note.field} = ${note.named} of issue ${note.id} ${why}; treated as no reference.\n\n` };
    }),
    ...(response.reviewer_feedback !== "" ? [{ kind: "RecordFeedback", round: n, text: response.reviewer_feedback } as ReviewCommand] : []),
    checkpoint(state, "responded"),
  ];
  const history = s.log;
  const entries = (id: string) => show(history.filter((e) => e.id === id));
  // The pause order of decided behaviour 7.
  const pauses: Ask[] = [
    ...log.secondClarifications(history, round).map((id): Ask => ({
      say: [`\nClaude Code requests clarification of issue ${id} a second time:`, entries(id), show(response.dispositions.find((d) => d.id === id))],
      subject: `issue ${id}, for which one clarification exchange did not produce a disposition`,
      id: id as IssueId,
    })),
    ...response.self_corrections.filter((sc) => sc.new_action === "rejected").map((sc): Ask => ({
      say: [`\nClaude Code now considers wrong the correction that it made for issue ${sc.id}: ${sc.explanation}`, entries(sc.id)],
      subject: `the accepted correction for ${sc.id}, which Claude Code now considers wrong`,
      id: sc.id as IssueId,
    })),
    ...log.reversals(round).map(([idNew, idOld]): Ask => ({
      say: [`\nIssue ${idNew} requests the reversal of the correction made for issue ${idOld}:`, entries(idOld), show(review.issues.find((i) => i.id === idNew)), show(response.dispositions.find((d) => d.id === idNew))],
      subject: `issue ${idNew} against the accepted correction for ${idOld}`,
      id: idNew as IssueId,
    })),
    ...log.repeatedUnderNewId(history, round).map(([idNew, idOld]): Ask => ({
      say: [`\nIssue ${idNew} repeats issue ${idOld}, which Claude Code did not accept in full, under a new id:`, entries(idOld), show(review.issues.find((i) => i.id === idNew))],
      subject: `issue ${idNew}, a repetition of issue ${idOld}`,
      id: idNew as IssueId,
    })),
    ...response.questions_for_user.map((question): Ask => ({ say: [""], subject: `question from Claude Code: ${question.replace(/\s+/g, " ")}`, id: null })),
  ];
  return askEach(state, pauses, (asking, queue) => ({ name: "askingPauses", asking, queue }), afterPauses, before);
};

const afterPauses = (s: ReviewState, before: readonly ReviewCommand[] = []): Transition =>
  s.current.decided ? { state: { ...s, step: { name: "applyingPauseDecisions" } }, commands: [...before, { kind: "ApplyDecisions" }] } : amendStep(s, before);

const amendStep = (s: ReviewState, before: readonly ReviewCommand[] = []): Transition =>
  s.setup.hasAmend ? { state: { ...s, step: { name: "amending" } }, commands: [...before, { kind: "Amend", round: s.round }] } : logStep(s, before);

/** The issue log update: the round, then the user's decisions on single issues, which replace the round's disposition. */
const logStep = (s: ReviewState, before: readonly ReviewCommand[] = []): Transition => {
  const { phase } = s.setup;
  const appended = log.appendRound(s.log, s.current.round!);
  const updated = s.current.decisions.reduce((acc, d) => (d.id === null ? acc : log.appendUserDecision(acc, d.id, d.decision, phase, s.round)), appended);
  return { state: { ...s, log: updated, step: { name: "observingResponse" } }, commands: [...before, { kind: "SaveLog", log: updated }, checkpoint(s, "logged"), { kind: "ObserveFile", stage: "response" }] };
};

const lastHash = (s: ReviewState): string => s.observations[s.observations.length - 1]?.hash ?? "";
const roundCounts = (s: ReviewState): { accepted: number; selfCount: number } => ({
  accepted: log.acceptedCount(s.current.round!),
  selfCount: s.current.response!.self_corrections.length,
});

/** Behaviour 7's identical-content pause, then the end of the round. */
const identicalCheck = (s: ReviewState, hash: string, stage: Stage, before: readonly ReviewCommand[] = []): Transition => {
  const { fileLabel } = s.setup;
  const seen = hash !== lastHash(s) ? s.observations.find((o) => o.hash === hash) : undefined;
  if (seen === undefined) return finishRound(s, hash, stage, before);
  return ask(
    s,
    { name: "askingIdentical", hash, stage, asking: { say: [], subject: `which of the two alternating versions of ${fileLabel} is correct`, id: null } },
    { say: [`\n${fileLabel} after round ${s.round} is identical to ${fileLabel} after ${describeObservation(seen)} (round 0 is the state at the start).`], subject: `which of the two alternating versions of ${fileLabel} is correct`, id: null },
    before,
  );
};

/** The observation of the round is recorded; the idle counter follows the policy; the idle pause when it is reached. */
const finishRound = (s: ReviewState, hash: string, stage: Stage, before: readonly ReviewCommand[] = []): Transition => {
  const { phase, maxIdleRounds } = s.setup;
  const { accepted, selfCount } = roundCounts(s);
  const idle = accepted === 0 && selfCount === 0 ? s.idle + 1 : 0;
  const state: ReviewState = { ...s, observations: [...s.observations, { round: s.round, stage, hash }], idle };
  if (idle < maxIdleRounds) return withBefore(startRound(state), before);
  const lines = [
    `\nClaude Code accepted no issue in ${idle} consecutive rounds. Issues of round ${s.round} without amendment:`,
    ...state.log.filter((x) => x.phase === phase && x.round === s.round && x.source === "review" && x.action !== "accepted").map((e) => `  - [${e.id}] (${e.action}) ${e.problem}\n      rationale: ${e.rationale}`),
  ];
  const asking: Ask = { say: lines, subject: `the issues of the last ${idle} rounds that produced no amendment`, id: null };
  return ask(state, { name: "askingIdle", asking }, asking, before);
};
const withBefore = (t: Transition, before: readonly ReviewCommand[]): Transition => (before.length === 0 ? t : { state: t.state, commands: [...before, ...t.commands] });

const onFileObserved = (s: ReviewState, hash: string): Transition => {
  const { fileLabel, heading } = s.setup;
  switch (s.step.name) {
    case "observingResponse": {
      const { accepted, selfCount } = roundCounts(s);
      const last = lastHash(s);
      if (accepted > 0 && hash === last) return halt(s, new AcceptedWithoutChange({ fileLabel, accepted }));
      if (accepted === 0 && selfCount === 0 && !s.current.decided && hash !== last) {
        const asking: Ask = {
          say: [`\n${fileLabel} changed in round ${s.round} without an accepted issue, a self-correction, or a user decision.`, `The free-text response of Claude Code: ${s.current.resultText || "none"}`],
          subject: `the unexplained change to ${fileLabel} in ${heading}, round ${s.round}`,
          id: null,
        };
        return ask(s, { name: "askingUnexplained", hash, asking }, asking);
      }
      return identicalCheck(s, hash, "response");
    }
    case "observingUnexplained":
      return identicalCheck(s, hash, "decision");
    case "observingIdentical":
      return finishRound(s, hash, "decision");
    case "observingIdle":
      return startRound({ ...s, observations: [...s.observations, { round: s.round, stage: "decision", hash }], idle: 0 });
    default:
      return noop(s);
  }
};

const onDecisionGiven = (s: ReviewState, text: string): Transition => {
  const step = s.step;
  const given = text !== "";
  switch (step.name) {
    case "askingReraised": {
      const decision = decisionOf(s, step.asking, text);
      const state: ReviewState = given ? { ...s, current: { ...s.current, decisions: [...s.current.decisions, decision] } } : s;
      return askEach(state, step.queue, (asking, queue) => ({ name: "askingReraised", asking, queue }), toResponse, given ? record(s, decision) : []);
    }
    case "askingPauses": {
      const decision = decisionOf(s, step.asking, text);
      const state: ReviewState = given ? { ...s, current: { ...s.current, decided: true, decisions: step.asking.id === null ? s.current.decisions : [...s.current.decisions, decision] } } : s;
      return askEach(state, step.queue, (asking, queue) => ({ name: "askingPauses", asking, queue }), afterPauses, given ? record(s, decision) : []);
    }
    case "askingUnexplained":
      return given
        ? { state: { ...s, step: { name: "applyingUnexplained" } }, commands: [...record(s, decisionOf(s, step.asking, text)), { kind: "ApplyDecisions" }] }
        : identicalCheck(s, step.hash, "response");
    case "askingIdentical":
      return given
        ? { state: { ...s, step: { name: "applyingIdentical" } }, commands: [...record(s, decisionOf(s, step.asking, text)), { kind: "ApplyDecisions" }] }
        : finishRound(s, step.hash, step.stage);
    case "askingIdle":
      return given
        ? { state: { ...s, step: { name: "applyingIdle" } }, commands: [...record(s, decisionOf(s, step.asking, text)), { kind: "ApplyDecisions" }] }
        : startRound({ ...s, idle: 0 });
    default:
      return noop(s);
  }
};

const onDecisionsApplied = (s: ReviewState): Transition => {
  switch (s.step.name) {
    case "applyingPauseDecisions":
      return amendStep(s);
    case "applyingUnexplained":
      return { state: { ...s, step: { name: "observingUnexplained" } }, commands: [{ kind: "ObserveFile", stage: "decision" }] };
    case "applyingIdentical":
      return { state: { ...s, step: { name: "observingIdentical" } }, commands: [{ kind: "ObserveFile", stage: "decision" }] };
    case "applyingIdle":
      return { state: { ...s, step: { name: "observingIdle" } }, commands: [{ kind: "ObserveFile", stage: "decision" }] };
    default:
      return noop(s);
  }
};

/** The next state and the commands to run for it. Pure and total: an event that does not fit the step is ignored. */
export const advance = (state: ReviewState, event: ReviewEvent): Transition => {
  switch (event.kind) {
    case "Begin":
      return startRound({ ...state, log: event.log, observations: [{ round: 0, stage: "start", hash: event.hash }] });
    case "LimitAnswer":
      return state.step.name === "awaitingLimit" ? onLimitAnswer(state, event.answer) : noop(state);
    case "ReviewDecoded":
      return state.step.name === "awaitingReview" ? onReviewDecoded(state, event.review) : noop(state);
    case "ResponseDecoded":
      return state.step.name === "awaitingResponse" ? onResponseDecoded(state, event.response, event.resultText, event.costUsd) : noop(state);
    case "DecisionGiven":
      return onDecisionGiven(state, event.text);
    case "DecisionsApplied":
      return onDecisionsApplied(state);
    case "Amended":
      return state.step.name === "amending" ? logStep(state) : noop(state);
    case "FileObserved":
      return onFileObserved(state, event.hash);
  }
};
