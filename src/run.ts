// The complete run: planning phase K, then execution phase K, until Claude Code reports 'finished'.

import * as path from "node:path";
import { questionPhase } from "./interview.ts";
import { executePrompt, initialPlanPrompt, revisePlanPrompt } from "./prompts.ts";
import { applyDecisions, askDecision, planningCall, reviewLoop, type Context } from "./review.ts";
import { planWriteSchema } from "./schemas.ts";
import { PlanNotWritten } from "./errors.ts";
import { planSubject } from "./subjects.ts";
import type { PlanWriteResult } from "./types.ts";

export async function run(ctx: Context, task: string): Promise<number> {
  const { state, ui } = ctx;
  state.init(task);
  const withRequirements = ctx.config.questionPhase;
  if (withRequirements) await questionPhase(ctx, task);

  for (let k = 1; ; k++) {
    const subject = planSubject(state, k, withRequirements);
    // Planning phase K: write or revise the plan, then review it.
    ui.say(k === 1 ? "Planning phase 1: requesting the initial plan from Claude Code ..." : `\nPlanning phase ${k}: Claude Code revises the plan from the user's input ...`);
    const written = await planningCall<PlanWriteResult>(ctx, k === 1 ? initialPlanPrompt(task, withRequirements) : revisePlanPrompt, planWriteSchema);
    state.writeJson(path.join(state.subDir(subject.dirName), "cc-0.json"), written.output);
    if (!state.planExists()) throw new PlanNotWritten({ file: "plan-review/plan.md" });

    let answered = false;
    for (const question of written.output.questions_for_user) {
      ui.say("");
      if ((await askDecision(ctx, `question from Claude Code: ${question.replace(/\s+/g, " ")}`)) !== "") answered = true;
    }
    if (answered) await applyDecisions(ctx, subject);

    await reviewLoop(ctx, subject);

    // Execution phase K.
    ui.say(`\nExecution phase ${k}: Claude Code implements the plan (permission mode ${ctx.config.execPermissionMode}) ...`);
    const outcome = await ctx.planner.executing(executePrompt);
    state.writeJson(path.join(state.subDir(`execution-${k}`), "result.json"), outcome);
    ui.say(`\nExecution phase ${k} ended with status: ${outcome.status}`);
    ui.say(`Summary: ${outcome.summary || "none"}`);
    if (outcome.status === "finished") return k;

    ui.say(`Remaining work: ${outcome.remainingWork || "not reported"}`);
    let input = outcome.userInput;
    if (input === null) {
      ui.say(`Question or description: ${outcome.question}`);
      input = "";
      while (input === "") input = await ui.ask("Your input for Claude Code (q = quit) > ");
    }
    const question = outcome.question.replace(/\s+/g, " ");
    state.recordDecision(`stop in execution phase ${k} (${outcome.status}): ${question}`, input);
  }
}
