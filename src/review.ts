// The review procedure: Codex reviews a file in rounds, Claude Code answers each issue, and the
// rounds end when a review contains no counted issue or when the user chooses to proceed.
// The procedure is applied to three subjects: the question list, the requirements, and the plan.

import { Effect, Schema } from "effect";
import * as path from "node:path";
import * as log from "./issueLog.ts";
import { AcceptedWithoutChange, AgentReplyInvalid, ProjectChanged, ReviewedFileChanged, RoundInvalid, RoundLimitStop, type RunError } from "./errors.ts";
import { parseExtraRounds } from "./input.ts";
import { repairReplyPrompt } from "./prompts.ts";
import * as S from "./schema.ts";
import type { PlannerResponse, Review } from "./schema.ts";
import { Planner, Reviewer, RunConfig, type Services, Store, type StoreError, Ui } from "./services.ts";
import { describeChange } from "./state.ts";

/** Codex's reply text, decoded as JSON and then as a review; text that is not JSON is a decode failure. */
const ReviewText = Schema.fromJsonString(S.Review);

/** What the review procedure is applied to. */
export type Subject<R extends PlannerResponse = PlannerResponse> = {
  /** Heading in conversation.md and in terminal output, for example "Planning phase 2". */
  heading: string;
  /** Name of the reviewed file as used in messages, for example "plan.md". */
  fileLabel: string;
  /** Absolute path of the reviewed file. */
  file: string;
  /** File name of the issue log of this subject. */
  logName: string;
  /** Subdirectory of plan-review/ for the JSON files of the rounds. */
  dirName: string;
  /** Number recorded in the phase field of log entries. */
  phase: number;
  reviewPrompt(round: number): string;
  respondPrompt(round: number): string;
  /** Effect schema of Claude Code's response to a review. */
  respondSchema: Schema.Decoder<R>;
  applyDecisionsPrompt: string;
  /** Effect schema of the output of the call that applies the user's decisions. */
  applyDecisionsSchema: Schema.Decoder<unknown>;
  /** Called after every Claude Code call of this subject, for output that the program writes to the file. */
  afterPlannerCall?(output: unknown): Effect.Effect<void, StoreError>;
  /** Called after the response of a round, for amendments that require the user (the requirements). */
  amend?(review: Review, response: R, round: number): Effect.Effect<void, RunError, Services>;
  /** Text of the "p" choice at the round limit. */
  proceedLabel: string;
};

/** Reads one decision. An empty answer records nothing and returns "". */
export const askDecision = (subject: string): Effect.Effect<string, RunError, Ui | Store> =>
  Effect.gen(function* () {
    const ui = yield* Ui;
    const store = yield* Store;
    const decision = yield* ui.ask(`Decision on: ${subject} (Enter = none, q = quit) > `);
    if (decision !== "") yield* store.recordDecision(subject, decision);
    return decision;
  });

const AGENT_LABEL = { claude: "Claude Code", codex: "Codex" } as const;

/** The text kept for an invalid reply. Total: a reply that JSON cannot represent is kept as a note of that failure. */
export const serializeReply = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch (e) {
    return `<reply not serializable: ${e instanceof Error ? e.message : String(e)}>`;
  }
};

/**
 * Decodes an agent's reply with its schema. A reply that does not match is kept on disk and the agent
 * gets one repair turn in the same session or thread; a second mismatch fails with AgentReplyInvalid.
 * Excess properties are ignored: they break no assumption of the program.
 */
export const decodeWithRepair = <Out extends Schema.Decoder<unknown>, E, R>(
  agent: keyof typeof AGENT_LABEL,
  schema: Out,
  reply: unknown,
  repair: (prompt: string) => Effect.Effect<unknown, E, R>,
): Effect.Effect<Out["Type"], E | AgentReplyInvalid | StoreError, R | Store> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const decode = (value: unknown): { ok: true; value: Out["Type"] } | { ok: false; issue: string } => {
      try {
        return { ok: true, value: Schema.decodeUnknownSync(schema, { errors: "all" })(value) };
      } catch (e) {
        if (Schema.isSchemaError(e)) return { ok: false, issue: e.message };
        throw e;
      }
    };
    const keep = (value: unknown): Effect.Effect<string, StoreError> => store.saveInvalidReply(agent, serializeReply(value));

    const first = decode(reply);
    if (first.ok) return first.value;
    const firstFile = yield* keep(reply);
    const secondReply = yield* repair(repairReplyPrompt(first.issue));
    const second = decode(secondReply);
    if (second.ok) return second.value;
    const secondFile = yield* keep(secondReply);
    return yield* Effect.fail(new AgentReplyInvalid({ agent: AGENT_LABEL[agent], issue: second.issue, files: [firstFile, secondFile] }));
  });

export type PlanningCall<Out> = { output: Out; resultText: string; costUsd: number | null };

/** A call in which Claude Code may write only under plan-review/. Halts if the project changed. */
export const planningCall = <Out extends Schema.Decoder<unknown>>(prompt: string, schema: Out, progress = false): Effect.Effect<PlanningCall<Out["Type"]>, RunError, Store | Planner> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const planner = yield* Planner;
    const call = (text: string) =>
      Effect.gen(function* () {
        const before = yield* store.projectSnapshot();
        const result = yield* planner.planning(text, schema, progress);
        const changes = describeChange(before, yield* store.projectSnapshot());
        if (changes.length > 0) return yield* Effect.fail(new ProjectChanged({ during: "planning", fileLabel: null, changes }));
        return result;
      });
    let last = yield* call(prompt);
    const repair = (text: string) => call(text).pipe(Effect.map((result) => (last = result).output));
    const output = yield* decodeWithRepair("claude", schema, last.output, repair);
    return { output, resultText: last.resultText, costUsd: last.costUsd };
  });

export const applyDecisions = (subject: Subject<any>): Effect.Effect<void, RunError, Services> =>
  Effect.gen(function* () {
    const call = yield* planningCall(subject.applyDecisionsPrompt, subject.applyDecisionsSchema);
    if (subject.afterPlannerCall) yield* subject.afterPlannerCall(call.output);
  });

function renderRound(heading: string, round: number, review: Review, response: PlannerResponse): string {
  const issues = review.issues.map((i) => `- **[${i.id}]** (${i.severity}, ${i.location}) ${i.problem}\n  Evidence: ${i.evidence}`);
  const answers = response.dispositions.map((d) => {
    const dup = d.duplicate_of !== "" ? ` (duplicate of ${d.duplicate_of})` : "";
    const rev = d.reverses !== "" ? ` (reverses ${d.reverses})` : "";
    return `- **[${d.id}]** ${d.action}${dup}${rev}: ${d.rationale}`;
  });
  const self = response.self_corrections.map((s) => `- **Self-correction** (${s.new_action}, issue "${s.id}"): ${s.explanation}`);
  const feedback = response.reviewer_feedback !== "" ? [`- **Feedback to the reviewer:** ${response.reviewer_feedback}`] : [];
  return `## ${heading}, round ${round}\n\n### Codex\n\n${issues.join("\n")}\n\n### Claude Code\n\n${[...answers, ...self, ...feedback].join("\n")}\n\n`;
}

export const reviewLoop = <R extends PlannerResponse>(subject: Subject<R>): Effect.Effect<"converged" | "proceed", RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    const config = yield* RunConfig;
    const reviewer = yield* Reviewer;
    const { heading, fileLabel, file, logName, phase } = subject;
    const dir = yield* store.subDir(subject.dirName);
    /** The content of the file after each round (and after a decision that changed it), for the identical-content pause. */
    type Observation = { round: number; stage: "start" | "response" | "decision"; hash: string };
    const observations: Observation[] = [{ round: 0, stage: "start", hash: yield* store.fileHash(file) }];
    const describeObservation = (o: Observation): string => (o.stage === "decision" ? `round ${o.round} (after the user's decision)` : `round ${o.round}`);
    const counts: number[] = [];
    const costs: (number | null)[] = [];
    let idle = 0;
    let limit = config.maxRounds;
    yield* reviewer.newPhase;

    for (let n = 1; ; n++) {
      // Pause at the round limit (usage and time).
      if (n > limit) {
        yield* ui.say(`\nCounted issues and reported Claude Code usage per round of ${heading}:`);
        for (const [i, c] of counts.entries()) yield* ui.say(`  round ${i + 1}: counted issues = ${c}, total_cost_usd = ${costs[i] ?? "not reported"}`);
        const extra = yield* ui.ask(`${limit} rounds completed without convergence. Number = additional rounds; p = ${subject.proceedLabel}; 0 = stop > `);
        if (extra === "p") {
          yield* store.converse(`**User decision:** ${subject.proceedLabel} without convergence after round ${n - 1} of ${heading}.\n\n`);
          return "proceed" as const;
        }
        const added = parseExtraRounds(extra);
        if (added === null) return yield* Effect.fail(new RoundLimitStop({ heading }));
        limit += added;
      }

      // Codex review. Codex runs without a sandbox, so the project and the reviewed file are compared
      // after every turn, including a repair turn.
      yield* ui.say(`\n${heading}, round ${n} (limit ${limit}): Codex review ...`);
      const reviewCall = (text: string) =>
        Effect.gen(function* () {
          const projectBefore = yield* store.projectSnapshot();
          const fileBefore = yield* store.fileHash(file);
          const reply = yield* reviewer.review(text);
          const changes = describeChange(projectBefore, yield* store.projectSnapshot());
          const fileChanged = (yield* store.fileHash(file)) !== fileBefore;
          if (fileChanged) changes.push(`content changed: ${fileLabel}`);
          if (fileChanged) return yield* Effect.fail(new ReviewedFileChanged({ fileLabel, changes }));
          if (changes.length > 0) return yield* Effect.fail(new ProjectChanged({ during: "review", fileLabel, changes }));
          return reply;
        });
      const review: Review = yield* decodeWithRepair("codex", ReviewText, yield* reviewCall(subject.reviewPrompt(n)), reviewCall);
      yield* store.writeJson(path.join(dir, `review-${n}.json`), review);
      // A review whose ids are not unique is invalid before anything is counted or asked (finding 3, decision Q3).
      const { duplicateIssues } = log.reviewProblems(review);
      if (duplicateIssues.length > 0) return yield* Effect.fail(new RoundInvalid({ duplicateIssues, missing: [], duplicateDispositions: [], unknownDispositions: [] }));
      const counted = log.countedIssues(review, config.countMinor);
      counts.push(counted);
      yield* ui.say(`Issues: ${review.issues.length} total, ${counted} counted toward convergence.`);
      if (counted === 0) {
        yield* store.converse(`## ${heading}, round ${n}\n\n### Codex\n\nNo counted issue. The review of ${fileLabel} has converged.\n\n`);
        return "converged" as const;
      }

      // Pause: Codex reused the id of an issue that was not accepted in full.
      let issueLog = yield* store.loadLog(logName);
      for (const id of log.reraisedIds(issueLog, review)) {
        yield* ui.say(`\nCodex has raised again an issue that Claude Code did not accept in full:`);
        yield* ui.say(JSON.stringify(issueLog.filter((e) => e.id === id), null, 2));
        yield* ui.say(JSON.stringify(review.issues.find((i) => i.id === id), null, 2));
        yield* askDecision(`issue ${id}, raised again after Claude Code did not accept it in full`);
      }

      // Claude Code response.
      yield* ui.say(`${heading}, round ${n}: Claude Code response ...`);
      const call = yield* planningCall(subject.respondPrompt(n), subject.respondSchema);
      const response: R = call.output;
      costs.push(call.costUsd);
      yield* store.writeJson(path.join(dir, `cc-${n}.json`), response);
      if (subject.afterPlannerCall) yield* subject.afterPlannerCall(response);
      // Exactly one disposition per review issue, and none for anything else, before the round is recorded.
      const problems = log.roundProblems(review, response);
      if (problems.missing.length + problems.duplicateDispositions.length + problems.unknownDispositions.length > 0) {
        return yield* Effect.fail(new RoundInvalid({ duplicateIssues: [], ...problems }));
      }
      yield* store.converse(renderRound(heading, n, review, response));
      if (response.reviewer_feedback !== "") yield* store.recordFeedback(heading, n, response.reviewer_feedback);

      // Pauses: items that require a decision of the user.
      let decided = false;
      const userDecisions: [string, string][] = [];
      const decide = (what: string, id: string | null) =>
        Effect.gen(function* () {
          const decision = yield* askDecision(what);
          if (decision === "") return;
          decided = true;
          if (id !== null) userDecisions.push([id, decision]);
        });
      const show = (value: unknown): Effect.Effect<void> => ui.say(JSON.stringify(value, null, 2));

      for (const id of log.secondClarifications(issueLog, response)) {
        yield* ui.say(`\nClaude Code requests clarification of issue ${id} a second time:`);
        yield* show(issueLog.filter((e) => e.id === id));
        yield* show(response.dispositions.find((d) => d.id === id));
        yield* decide(`issue ${id}, for which one clarification exchange did not produce a disposition`, id);
      }
      for (const sc of response.self_corrections.filter((s) => s.new_action === "rejected")) {
        yield* ui.say(`\nClaude Code now considers wrong the correction that it made for issue ${sc.id}: ${sc.explanation}`);
        yield* show(issueLog.filter((e) => e.id === sc.id));
        yield* decide(`the accepted correction for ${sc.id}, which Claude Code now considers wrong`, sc.id);
      }
      for (const [idNew, idOld] of log.reversals(response)) {
        yield* ui.say(`\nIssue ${idNew} requests the reversal of the correction made for issue ${idOld}:`);
        yield* show(issueLog.filter((e) => e.id === idOld));
        yield* show(review.issues.find((i) => i.id === idNew));
        yield* show(response.dispositions.find((d) => d.id === idNew));
        yield* decide(`issue ${idNew} against the accepted correction for ${idOld}`, idNew);
      }
      for (const [idNew, idOld] of log.repeatedUnderNewId(issueLog, response)) {
        yield* ui.say(`\nIssue ${idNew} repeats issue ${idOld}, which Claude Code did not accept in full, under a new id:`);
        yield* show(issueLog.filter((e) => e.id === idOld));
        yield* show(review.issues.find((i) => i.id === idNew));
        yield* decide(`issue ${idNew}, a repetition of issue ${idOld}`, idNew);
      }
      for (const question of response.questions_for_user) {
        yield* ui.say("");
        yield* decide(`question from Claude Code: ${question.replace(/\s+/g, " ")}`, null);
      }
      if (decided) yield* applyDecisions(subject);

      // Amendments that require the user.
      if (subject.amend) yield* subject.amend(review, response, n);

      // Issue log update. Decisions of the user on single issues replace the disposition of the round.
      issueLog = log.appendRound(issueLog, review, response, phase, n);
      for (const [id, decision] of userDecisions) issueLog = log.appendUserDecision(issueLog, id, decision, phase, n);
      yield* store.saveLog(logName, issueLog);

      // Progress checks.
      const accepted = log.acceptedCount(response);
      const selfCount = response.self_corrections.length;
      const last = observations[observations.length - 1].hash;
      let hash = yield* store.fileHash(file);
      let stage: Observation["stage"] = "response";

      if (accepted > 0 && hash === last) return yield* Effect.fail(new AcceptedWithoutChange({ fileLabel, accepted }));

      if (accepted === 0 && selfCount === 0 && !decided && hash !== last) {
        yield* ui.say(`\n${fileLabel} changed in round ${n} without an accepted issue, a self-correction, or a user decision.`);
        yield* ui.say(`The free-text response of Claude Code: ${call.resultText || "none"}`);
        if ((yield* askDecision(`the unexplained change to ${fileLabel} in ${heading}, round ${n}`)) !== "") {
          yield* applyDecisions(subject);
          hash = yield* store.fileHash(file);
          stage = "decision";
        }
      }

      const seen = hash !== last ? observations.find((o) => o.hash === hash) : undefined;
      if (seen !== undefined) {
        yield* ui.say(`\n${fileLabel} after round ${n} is identical to ${fileLabel} after ${describeObservation(seen)} (round 0 is the state at the start).`);
        if ((yield* askDecision(`which of the two alternating versions of ${fileLabel} is correct`)) !== "") {
          yield* applyDecisions(subject);
          hash = yield* store.fileHash(file);
          stage = "decision";
        }
      }
      observations.push({ round: n, stage, hash });

      idle = accepted === 0 && selfCount === 0 ? idle + 1 : 0;
      if (idle >= config.maxIdleRounds) {
        yield* ui.say(`\nClaude Code accepted no issue in ${idle} consecutive rounds. Issues of round ${n} without amendment:`);
        for (const e of issueLog.filter((x) => x.phase === phase && x.round === n && x.source === "review" && x.action !== "accepted")) {
          yield* ui.say(`  - [${e.id}] (${e.action}) ${e.problem}\n      rationale: ${e.rationale}`);
        }
        if ((yield* askDecision(`the issues of the last ${idle} rounds that produced no amendment`)) !== "") {
          yield* applyDecisions(subject);
          observations.push({ round: n, stage: "decision", hash: yield* store.fileHash(file) });
        }
        idle = 0;
      }
    }
  });
