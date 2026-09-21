// The complete run: planning phase K, then execution phase K, until Claude Code reports 'finished'.

import * as path from "node:path";
import { executePrompt, initialPlanPrompt, revisePlanPrompt } from "./prompts.ts";
import { applyDecisions, askDecision, planningCall, reviewLoop, type Context } from "./review.ts";
import { planWriteSchema } from "./schemas.ts";
import { Halt } from "./state.ts";
import type { PlanWriteResult } from "./types.ts";

export async function run(ctx: Context, task: string): Promise<number> {
  const { state, ui } = ctx;
  state.init(task);

  for (let k = 1; ; k++) {
    // Planning phase K: write or revise the plan, then review it.
    ui.say(k === 1 ? "Planning phase 1: requesting the initial plan from Claude Code ..." : `\nPlanning phase ${k}: Claude Code revises the plan from the user's input ...`);
    const written = await planningCall<PlanWriteResult>(ctx, k === 1 ? initialPlanPrompt(task) : revisePlanPrompt, planWriteSchema);
    state.writeJson(path.join(state.phaseDir("planning", k), "cc-0.json"), written.output);
    if (!state.planExists()) throw new Halt("Claude Code did not write plan-review/plan.md");

    let answered = false;
    for (const question of written.output.questions_for_user) {
      ui.say("");
      if ((await askDecision(ctx, `question from Claude Code: ${question.replace(/\s+/g, " ")}`)) !== "") answered = true;
    }
    if (answered) await applyDecisions(ctx);

    await reviewLoop(ctx, k);

    // Execution phase K.
    ui.say(`\nExecution phase ${k}: Claude Code implements the plan (permission mode ${ctx.config.execPermissionMode}) ...`);
    const outcome = await ctx.planner.executing(executePrompt);
    state.writeJson(path.join(state.phaseDir("execution", k), "result.json"), outcome);
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
