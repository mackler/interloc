// One planning phase after the plan has been written or revised: review rounds until a review
// contains no counted issue, or until the user chooses to proceed.

import * as path from "node:path";
import type { Planner, Reviewer } from "./agents.ts";
import * as log from "./issueLog.ts";
import { applyDecisionsPrompt, respondPrompt, reviewPrompt } from "./prompts.ts";
import { planWriteSchema, plannerResponseSchema } from "./schemas.ts";
import { Halt, type State } from "./state.ts";
import type { Config, PlanWriteResult, PlannerResponse, Review } from "./types.ts";
import type { Ui } from "./ui.ts";

export type Context = { state: State; ui: Ui; planner: Planner; reviewer: Reviewer; config: Config };

/** Reads one decision. An empty answer records nothing and returns "". */
export async function askDecision(ctx: Context, subject: string): Promise<string> {
  const decision = await ctx.ui.ask(`Decision on: ${subject} (Enter = none, q = quit) > `);
  if (decision !== "") ctx.state.recordDecision(subject, decision);
  return decision;
}

/** A planning call. Halts if the call changed the project outside plan-review/. */
export async function planningCall<T>(ctx: Context, prompt: string, schema: object): Promise<{ output: T; resultText: string; costUsd: number | null }> {
  const before = ctx.state.projectState();
  const result = await ctx.planner.planning<T>(prompt, schema);
  if (ctx.state.projectState() !== before) throw new Halt("a planning-phase call changed the project outside plan-review/");
  return result;
}

export async function applyDecisions(ctx: Context): Promise<void> {
  await planningCall<PlanWriteResult>(ctx, applyDecisionsPrompt, planWriteSchema);
}

function renderRound(phase: number, round: number, review: Review, response: PlannerResponse): string {
  const issues = review.issues.map((i) => `- **[${i.id}]** (${i.severity}, ${i.plan_section}) ${i.problem}\n  Evidence: ${i.evidence}`);
  const answers = response.dispositions.map((d) => {
    const dup = d.duplicate_of !== "" ? ` (duplicate of ${d.duplicate_of})` : "";
    const rev = d.reverses !== "" ? ` (reverses ${d.reverses})` : "";
    return `- **[${d.id}]** ${d.action}${dup}${rev}: ${d.rationale}`;
  });
  const self = response.self_corrections.map((s) => `- **Self-correction** (${s.new_action}, issue "${s.id}"): ${s.explanation}`);
  const feedback = response.reviewer_feedback !== "" ? [`- **Feedback to the reviewer:** ${response.reviewer_feedback}`] : [];
  return `## Planning phase ${phase}, round ${round}\n\n### Codex\n\n${issues.join("\n")}\n\n### Claude Code\n\n${[...answers, ...self, ...feedback].join("\n")}\n\n`;
}

export async function reviewLoop(ctx: Context, phase: number): Promise<"converged" | "proceed"> {
  const { state, ui, config } = ctx;
  const dir = state.phaseDir("planning", phase);
  const hashes: string[] = [state.planHash()];
  const counts: number[] = [];
  const costs: (number | null)[] = [];
  let idle = 0;
  let limit = config.maxRounds;
  ctx.reviewer.newPhase();

  for (let n = 1; ; n++) {
    // Pause at the round limit (usage and time).
    if (n > limit) {
      ui.say(`\nCounted issues and reported Claude Code usage per round of planning phase ${phase}:`);
      counts.forEach((c, i) => ui.say(`  round ${i + 1}: counted issues = ${c}, total_cost_usd = ${costs[i] ?? "not reported"}`));
      const extra = await ui.ask(`${limit} rounds completed without convergence. Number = additional rounds; p = proceed to execution with the plan as it is; 0 = stop > `);
      if (extra === "p") {
        state.converse(`**User decision:** proceed to execution without convergence after round ${n - 1}.\n\n`);
        return "proceed";
      }
      if (!/^[1-9][0-9]*$/.test(extra)) throw new Halt(`stopped by the user at the round limit of planning phase ${phase}`);
      limit += Number(extra);
    }

    // Codex review. Codex runs without a sandbox, so the project and the plan are compared afterwards.
    ui.say(`\nPlanning phase ${phase}, round ${n} (limit ${limit}): Codex review ...`);
    const projectBefore = state.projectState();
    const planBefore = state.planHash();
    const review = await ctx.reviewer.review(reviewPrompt(phase, n));
    if (state.projectState() !== projectBefore || state.planHash() !== planBefore) {
      throw new Halt("the Codex review changed the project or the plan");
    }
    state.writeJson(path.join(dir, `review-${n}.json`), review);
    const counted = log.countedIssues(review, config.countMinor);
    counts.push(counted);
    ui.say(`Issues: ${review.issues.length} total, ${counted} counted toward convergence.`);
    if (counted === 0) {
      state.converse(`## Planning phase ${phase}, round ${n}\n\n### Codex\n\nNo counted issue. The plan has converged.\n\n`);
      return "converged";
    }

    // Pause: Codex reused the id of an issue that was not accepted in full.
    let issueLog = state.loadLog();
    for (const id of log.reraisedIds(issueLog, review)) {
      ui.say(`\nCodex has raised again an issue that Claude Code did not accept in full:`);
      ui.say(JSON.stringify(issueLog.filter((e) => e.id === id), null, 2));
      ui.say(JSON.stringify(review.issues.find((i) => i.id === id), null, 2));
      await askDecision(ctx, `issue ${id}, raised again after Claude Code did not accept it in full`);
    }

    // Claude Code response.
    ui.say(`Planning phase ${phase}, round ${n}: Claude Code response ...`);
    const call = await planningCall<PlannerResponse>(ctx, respondPrompt(phase, n), plannerResponseSchema);
    const response = call.output;
    costs.push(call.costUsd);
    state.writeJson(path.join(dir, `cc-${n}.json`), response);
    const missing = log.missingDispositions(review, response);
    if (missing.length > 0) throw new Halt(`Claude Code returned no disposition for: ${missing.join(", ")}`);
    state.converse(renderRound(phase, n, review, response));
    if (response.reviewer_feedback !== "") state.recordFeedback(phase, n, response.reviewer_feedback);

    // Pauses: items that require a decision of the user.
    let decided = false;
    const userDecisions: [string, string][] = [];
    const decide = async (subject: string, id: string | null): Promise<void> => {
      const decision = await askDecision(ctx, subject);
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
    if (decided) await applyDecisions(ctx);

    // Issue log update. Decisions of the user on single issues replace the disposition of the round.
    issueLog = log.appendRound(issueLog, review, response, phase, n);
    for (const [id, decision] of userDecisions) issueLog = log.appendUserDecision(issueLog, id, decision, phase, n);
    state.saveLog(issueLog);

    // Progress checks.
    const accepted = log.acceptedCount(response);
    const selfCount = response.self_corrections.length;
    const last = hashes[hashes.length - 1];
    let hash = state.planHash();

    if (accepted > 0 && hash === last) throw new Halt(`Claude Code accepted ${accepted} issues in full or in part but plan.md is unchanged`);

    if (accepted === 0 && selfCount === 0 && !decided && hash !== last) {
      ui.say(`\nplan.md changed in round ${n} without an accepted issue, a self-correction, or a user decision.`);
      ui.say(`The free-text response of Claude Code: ${call.resultText || "none"}`);
      if ((await askDecision(ctx, `the unexplained change to plan.md in planning phase ${phase}, round ${n}`)) !== "") {
        await applyDecisions(ctx);
        hash = state.planHash();
      }
    }

    const earlier = hash !== last ? hashes.indexOf(hash) : -1;
    if (earlier >= 0) {
      ui.say(`\nplan.md after round ${n} is identical to plan.md after round ${earlier} (round 0 is the plan at the start of the phase).`);
      if ((await askDecision(ctx, "which of the two alternating plan versions is correct")) !== "") {
        await applyDecisions(ctx);
        hash = state.planHash();
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
        await applyDecisions(ctx);
        hashes.push(state.planHash());
      }
      idle = 0;
    }
  }
}
