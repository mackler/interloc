// The complete run: planning phase K, then execution phase K, until Claude Code reports 'finished'.

import { Effect } from "effect";
import * as path from "node:path";
import { PlanNotWritten, type RunError } from "./errors.ts";
import { questionPhase } from "./interview.ts";
import { executePrompt, initialPlanPrompt, revisePlanPrompt } from "./prompts.ts";
import { applyDecisions, askDecision, planningCall, reviewLoop } from "./review.ts";
import * as S from "./schema.ts";
import { Planner, RunConfig, type Services, Store, Ui } from "./services.ts";
import { planSubject } from "./subjects.ts";

/** The whole run. Succeeds with the number of execution phases when Claude Code reports 'finished'. */
export const run = (task: string): Effect.Effect<number, RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    const config = yield* RunConfig;
    const planner = yield* Planner;
    yield* store.init(task);
    const withRequirements = config.questionPhase;
    if (withRequirements) yield* questionPhase(task);

    for (let k = 1; ; k++) {
      const subject = planSubject(store, k, withRequirements);
      // Planning phase K: write or revise the plan, then review it.
      yield* ui.say(k === 1 ? "Planning phase 1: requesting the initial plan from Claude Code ..." : `\nPlanning phase ${k}: Claude Code revises the plan from the user's input ...`);
      const written = yield* planningCall(k === 1 ? initialPlanPrompt(task, withRequirements) : revisePlanPrompt, S.PlanWriteResult);
      yield* store.writeJson(path.join(yield* store.subDir(subject.dirName), "cc-0.json"), written.output);
      if (!(yield* store.planExists())) return yield* Effect.fail(new PlanNotWritten({ file: "plan-review/plan.md" }));

      let answered = false;
      for (const question of written.output.questions_for_user) {
        yield* ui.say("");
        if ((yield* askDecision(`question from Claude Code: ${question.replace(/\s+/g, " ")}`)) !== "") answered = true;
      }
      if (answered) yield* applyDecisions(subject);

      yield* reviewLoop(subject);

      // Execution phase K.
      yield* ui.say(`\nExecution phase ${k}: Claude Code implements the plan (permission mode ${config.execPermissionMode}) ...`);
      const outcome = yield* planner.executing(executePrompt);
      yield* store.writeJson(path.join(yield* store.subDir(`execution-${k}`), "result.json"), outcome);
      yield* ui.say(`\nExecution phase ${k} ended with status: ${outcome.status}`);
      yield* ui.say(`Summary: ${outcome.summary || "none"}`);
      if (outcome.status === "finished") return k;

      yield* ui.say(`Remaining work: ${outcome.remainingWork || "not reported"}`);
      let input = outcome.userInput;
      if (input === null) {
        yield* ui.say(`Question or description: ${outcome.question}`);
        input = "";
        while (input === "") input = yield* ui.ask("Your input for Claude Code (q = quit) > ");
      }
      const question = outcome.question.replace(/\s+/g, " ");
      yield* store.recordDecision(`stop in execution phase ${k} (${outcome.status}): ${question}`, input);
    }
  });
