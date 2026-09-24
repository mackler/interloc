// The review procedure: Codex reviews a file in rounds, Claude Code answers each issue, and the
// rounds end when a review contains no counted issue or when the user chooses to proceed.
// The procedure is applied to three subjects: the question list, the requirements, and the plan.

import * as path from "node:path";
import type { Planner, Reviewer } from "./agents.ts";
import * as log from "./issueLog.ts";
import { AcceptedWithoutChange, MissingDispositions, ProjectChanged, ReviewedFileChanged, RoundLimitStop } from "./errors.ts";
import { describeChange, type State } from "./state.ts";
import type { Config, PlannerResponse, Review } from "./types.ts";
import type { Ui } from "./ui.ts";

export type Context = { state: State; ui: Ui; planner: Planner; reviewer: Reviewer; config: Config };

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
  respondSchema: object;
  applyDecisionsPrompt: string;
  applyDecisionsSchema: object;
  /** Called after every Claude Code call of this subject, for output that the program writes to the file. */
  afterPlannerCall?(output: unknown): void;
  /** Called after the response of a round, for amendments that require the user (the requirements). */
  amend?(ctx: Context, review: Review, response: R, round: number): Promise<void>;
  /** Text of the "p" choice at the round limit. */
  proceedLabel: string;
};

/** Reads one decision. An empty answer records nothing and returns "". */
export async function askDecision(ctx: Context, subject: string): Promise<string> {
  const decision = await ctx.ui.ask(`Decision on: ${subject} (Enter = none, q = quit) > `);
  if (decision !== "") ctx.state.recordDecision(subject, decision);
  return decision;
}

/** A call in which Claude Code may write only under plan-review/. Halts if the project changed. */
export async function planningCall<T>(ctx: Context, prompt: string, schema: object, progress = false): Promise<{ output: T; resultText: string; costUsd: number | null }> {
  const before = ctx.state.projectSnapshot();
  const result = await ctx.planner.planning<T>(prompt, schema, progress);
  const changes = describeChange(before, ctx.state.projectSnapshot());
  if (changes.length > 0) {
    throw new ProjectChanged({ during: "planning", fileLabel: null, changes });
  }
  return result;
}

export async function applyDecisions(ctx: Context, subject: Subject<any>): Promise<void> {
  const call = await planningCall<unknown>(ctx, subject.applyDecisionsPrompt, subject.applyDecisionsSchema);
  subject.afterPlannerCall?.(call.output);
}

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

export async function reviewLoop<R extends PlannerResponse>(ctx: Context, subject: Subject<R>): Promise<"converged" | "proceed"> {
  const { state, ui, config } = ctx;
  const { heading, fileLabel, file, logName, phase } = subject;
  const dir = state.subDir(subject.dirName);
  const hashes: string[] = [state.fileHash(file)];
  const counts: number[] = [];
  const costs: (number | null)[] = [];
  let idle = 0;
  let limit = config.maxRounds;
  ctx.reviewer.newPhase();

  for (let n = 1; ; n++) {
    // Pause at the round limit (usage and time).
    if (n > limit) {
      ui.say(`\nCounted issues and reported Claude Code usage per round of ${heading}:`);
      counts.forEach((c, i) => ui.say(`  round ${i + 1}: counted issues = ${c}, total_cost_usd = ${costs[i] ?? "not reported"}`));
      const extra = await ui.ask(`${limit} rounds completed without convergence. Number = additional rounds; p = ${subject.proceedLabel}; 0 = stop > `);
      if (extra === "p") {
        state.converse(`**User decision:** ${subject.proceedLabel} without convergence after round ${n - 1} of ${heading}.\n\n`);
        return "proceed";
      }
      if (!/^[1-9][0-9]*$/.test(extra)) throw new RoundLimitStop({ heading });
      limit += Number(extra);
    }

    // Codex review. Codex runs without a sandbox, so the project and the reviewed file are compared afterwards.
    ui.say(`\n${heading}, round ${n} (limit ${limit}): Codex review ...`);
    const projectBefore = state.projectSnapshot();
    const fileBefore = state.fileHash(file);
    const review = await ctx.reviewer.review(subject.reviewPrompt(n));
    const changes = describeChange(projectBefore, state.projectSnapshot());
    const fileChanged = state.fileHash(file) !== fileBefore;
    if (fileChanged) changes.push(`content changed: ${fileLabel}`);
    if (fileChanged) throw new ReviewedFileChanged({ fileLabel, changes });
    if (changes.length > 0) throw new ProjectChanged({ during: "review", fileLabel, changes });
    state.writeJson(path.join(dir, `review-${n}.json`), review);
    const counted = log.countedIssues(review, config.countMinor);
    counts.push(counted);
    ui.say(`Issues: ${review.issues.length} total, ${counted} counted toward convergence.`);
    if (counted === 0) {
      state.converse(`## ${heading}, round ${n}\n\n### Codex\n\nNo counted issue. The review of ${fileLabel} has converged.\n\n`);
      return "converged";
    }

    // Pause: Codex reused the id of an issue that was not accepted in full.
    let issueLog = state.loadLog(logName);
    for (const id of log.reraisedIds(issueLog, review)) {
      ui.say(`\nCodex has raised again an issue that Claude Code did not accept in full:`);
      ui.say(JSON.stringify(issueLog.filter((e) => e.id === id), null, 2));
      ui.say(JSON.stringify(review.issues.find((i) => i.id === id), null, 2));
      await askDecision(ctx, `issue ${id}, raised again after Claude Code did not accept it in full`);
    }

    // Claude Code response.
    ui.say(`${heading}, round ${n}: Claude Code response ...`);
    const call = await planningCall<R>(ctx, subject.respondPrompt(n), subject.respondSchema);
    const response = call.output;
    costs.push(call.costUsd);
    state.writeJson(path.join(dir, `cc-${n}.json`), response);
    subject.afterPlannerCall?.(response);
    const missing = log.missingDispositions(review, response);
    if (missing.length > 0) throw new MissingDispositions({ ids: missing });
    state.converse(renderRound(heading, n, review, response));
    if (response.reviewer_feedback !== "") state.recordFeedback(heading, n, response.reviewer_feedback);

    // Pauses: items that require a decision of the user.
    let decided = false;
    const userDecisions: [string, string][] = [];
    const decide = async (what: string, id: string | null): Promise<void> => {
      const decision = await askDecision(ctx, what);
      if (decision === "") return;
      decided = true;
      if (id !== null) userDecisions.push([id, decision]);
    };
    const show = (value: unknown): void => ui.say(JSON.stringify(value, null, 2));

    for (const id of log.secondClarifications(issueLog, response)) {
      ui.say(`\nClaude Code requests clarification of issue ${id} a second time:`);
      show(issueLog.filter((e) => e.id === id));
      show(response.dispositions.find((d) => d.id === id));
      await decide(`issue ${id}, for which one clarification exchange did not produce a disposition`, id);
    }
    for (const sc of response.self_corrections.filter((s) => s.new_action === "rejected")) {
      ui.say(`\nClaude Code now considers wrong the correction that it made for issue ${sc.id}: ${sc.explanation}`);
      show(issueLog.filter((e) => e.id === sc.id));
      await decide(`the accepted correction for ${sc.id}, which Claude Code now considers wrong`, sc.id);
    }
    for (const [idNew, idOld] of log.reversals(response)) {
      ui.say(`\nIssue ${idNew} requests the reversal of the correction made for issue ${idOld}:`);
      show(issueLog.filter((e) => e.id === idOld));
      show(review.issues.find((i) => i.id === idNew));
      show(response.dispositions.find((d) => d.id === idNew));
      await decide(`issue ${idNew} against the accepted correction for ${idOld}`, idNew);
    }
    for (const [idNew, idOld] of log.repeatedUnderNewId(issueLog, response)) {
      ui.say(`\nIssue ${idNew} repeats issue ${idOld}, which Claude Code did not accept in full, under a new id:`);
      show(issueLog.filter((e) => e.id === idOld));
      show(review.issues.find((i) => i.id === idNew));
      await decide(`issue ${idNew}, a repetition of issue ${idOld}`, idNew);
    }
    for (const question of response.questions_for_user) {
      ui.say("");
      await decide(`question from Claude Code: ${question.replace(/\s+/g, " ")}`, null);
    }
    if (decided) await applyDecisions(ctx, subject);

    // Amendments that require the user.
    if (subject.amend) await subject.amend(ctx, review, response, n);

    // Issue log update. Decisions of the user on single issues replace the disposition of the round.
    issueLog = log.appendRound(issueLog, review, response, phase, n);
    for (const [id, decision] of userDecisions) issueLog = log.appendUserDecision(issueLog, id, decision, phase, n);
    state.saveLog(logName, issueLog);

    // Progress checks.
    const accepted = log.acceptedCount(response);
    const selfCount = response.self_corrections.length;
    const last = hashes[hashes.length - 1];
    let hash = state.fileHash(file);

    if (accepted > 0 && hash === last) throw new AcceptedWithoutChange({ fileLabel, accepted });

    if (accepted === 0 && selfCount === 0 && !decided && hash !== last) {
      ui.say(`\n${fileLabel} changed in round ${n} without an accepted issue, a self-correction, or a user decision.`);
      ui.say(`The free-text response of Claude Code: ${call.resultText || "none"}`);
      if ((await askDecision(ctx, `the unexplained change to ${fileLabel} in ${heading}, round ${n}`)) !== "") {
        await applyDecisions(ctx, subject);
        hash = state.fileHash(file);
      }
    }

    const earlier = hash !== last ? hashes.indexOf(hash) : -1;
    if (earlier >= 0) {
      ui.say(`\n${fileLabel} after round ${n} is identical to ${fileLabel} after round ${earlier} (round 0 is the state at the start).`);
      if ((await askDecision(ctx, `which of the two alternating versions of ${fileLabel} is correct`)) !== "") {
        await applyDecisions(ctx, subject);
        hash = state.fileHash(file);
      }
    }
    hashes.push(hash);

    idle = accepted === 0 && selfCount === 0 ? idle + 1 : 0;
    if (idle >= config.maxIdleRounds) {
      ui.say(`\nClaude Code accepted no issue in ${idle} consecutive rounds. Issues of round ${n} without amendment:`);
      for (const e of issueLog.filter((x) => x.phase === phase && x.round === n && x.source === "review" && x.action !== "accepted")) {
        ui.say(`  - [${e.id}] (${e.action}) ${e.problem}\n      rationale: ${e.rationale}`);
      }
      if ((await askDecision(ctx, `the issues of the last ${idle} rounds that produced no amendment`)) !== "") {
        await applyDecisions(ctx, subject);
        hashes.push(state.fileHash(file));
      }
      idle = 0;
    }
  }
}
