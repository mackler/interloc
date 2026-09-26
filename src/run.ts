// The complete run: planning phase K, execution phase K and work review K, until Claude Code reports
// 'finished' and the work review converges.

import { Effect } from "effect";
import { recordPath } from "./artifacts.ts";
import { PlanNotWritten, type RunError } from "./errors.ts";
import { questionPhase } from "./interview.ts";
import { execInputPrompt, executePrompt, initialPlanPrompt, revisePlanAfterExecutionPrompt, type WorkReviewEnd } from "./prompts.ts";
import { applyDecisions, askDecision, planningCall, reviewLoop } from "./review.ts";
import * as S from "./schema.ts";
import { Planner, RunConfig, type Services, Store, Ui } from "./services.ts";
import { planSubject, workSubject } from "./subjects.ts";
import { askNonEmpty } from "./ui.ts";

/** The whole run. Succeeds with the number of execution phases when Claude Code reports 'finished' and the work review converges. */
export const run = (task: string): Effect.Effect<number, RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    const config = yield* RunConfig;
    const planner = yield* Planner;
    yield* store.init(task);
    // The SDK does not report which model answered a Codex turn; the configured one is all that can be said.
    yield* ui.say(`Codex model: ${config.codexModel ?? "the default of the Codex login"}`);
    const withRequirements = config.questionPhase;
    if (withRequirements) yield* questionPhase(task);

    /** How the previous execution phase and its work review ended; the next plan revision is written from it. */
    let previous: Readonly<{ stopped: boolean; workReview: WorkReviewEnd }> | null = null;
    for (let k = 1; ; k++) {
      const subject = planSubject(k, withRequirements);
      // Planning phase K: write or revise the plan, then review it.
      yield* ui.notify({ _tag: "PhaseBegan", phase: { kind: "planning", n: k } });
      yield* ui.say(previous === null ? "Planning phase 1: requesting the initial plan from Claude Code ..." : `\nPlanning phase ${k}: Claude Code revises the plan ...`);
      const written = yield* planningCall(previous === null ? initialPlanPrompt(task, withRequirements) : revisePlanAfterExecutionPrompt(k - 1, previous), S.PlanWriteResult);
      yield* store.savePlanWrite(k, written.output);
      yield* ui.notify({ _tag: "PlanWritten", phase: k, questions: written.output.questions_for_user, resultText: written.resultText });
      if (!(yield* store.planExists())) return yield* Effect.fail(new PlanNotWritten({ file: recordPath({ kind: "plan" }) }));

      let answered = false;
      for (const question of written.output.questions_for_user) {
        yield* ui.say("");
        if ((yield* askDecision(`question from Claude Code: ${question.replace(/\s+/g, " ")}`, k, 0)) !== "") answered = true;
      }
      if (answered) yield* applyDecisions(subject);

      const reviewed = yield* reviewLoop(subject);
      yield* ui.notify({ _tag: "PhaseEnded", phase: { kind: "planning", n: k }, result: reviewed.result });

      // Execution phase K.
      yield* ui.notify({ _tag: "PhaseBegan", phase: { kind: "execution", n: k } });
      yield* ui.say(`\nExecution phase ${k}: Claude Code implements the plan (permission mode ${config.execPermissionMode}) ...`);
      const outcome = yield* planner.executing(executePrompt);
      yield* store.saveExecution(k, outcome);
      yield* store.checkpoint({ subject: "execution", phase: k, round: 0, stage: "executed" });
      yield* ui.notify({ _tag: "ExecutionEnded", phase: k, outcome });
      yield* ui.notify({ _tag: "PhaseEnded", phase: { kind: "execution", n: k }, result: outcome.status });
      yield* ui.say(`\nExecution phase ${k} ended with status: ${outcome.status}`);
      yield* ui.say(`Summary: ${outcome.summary || "none"}`);
      const stopped = outcome.status !== "finished";
      if (stopped) {
        // A stop is handled as before the work review existed: its input is recorded first.
        yield* ui.say(`Remaining work: ${outcome.remainingWork || "not reported"}`);
        const input =
          outcome.userInput ??
          (yield* ui.say(`Question or description: ${outcome.question}`).pipe(Effect.andThen(askNonEmpty((p) => ui.ask(p), execInputPrompt))));
        const question = outcome.question.replace(/\s+/g, " ");
        yield* store.appendDecision({ subject: `stop in execution phase ${k} (${outcome.status}): ${question}`, id: null, decision: input, phase: k, round: 0 });
      }

      // Work review K, after every execution phase whatever its status (behaviour 12).
      yield* ui.notify({ _tag: "PhaseBegan", phase: { kind: "work", n: k } });
      yield* ui.say(`\nWork review ${k}: Codex reviews the changes to the project since the run began ...`);
      const work = yield* reviewLoop(workSubject(k, withRequirements));
      yield* ui.notify({ _tag: "PhaseEnded", phase: { kind: "work", n: k }, result: work.result });
      // The run is finished only when Claude Code reported finished and the work review converged.
      if (!stopped && work.result === "converged") return k;
      previous = { stopped, workReview: work.result === "converged" ? "converged" : { revisedInRound: work.round } };
    }
  });
