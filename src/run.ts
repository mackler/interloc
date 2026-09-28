// The complete run: planning phase K, execution phase K and work review K, until Claude Code reports
// 'finished' and the work review converges.

import { Effect } from "effect";
import { recordPath } from "./artifacts.ts";
import { PlanNotWritten, type RunError } from "./errors.ts";
import { questionPhase } from "./interview.ts";
import { execInputPrompt, executePrompt, implementationBeganLine, implementationEndedLine, initialPlanPrompt, revisePlanAfterExecutionPrompt, type WorkReviewEnd } from "./prompts.ts";
import { applyDecisions, askDecision, planningCall, reviewLoop } from "./review.ts";
import * as S from "./schema.ts";
import { Decider, Planner, RunConfig, type Services, Store, Ui } from "./services.ts";
import type { Phase } from "./uiEvents.ts";
import { planSubject, workSubject } from "./subjects.ts";
import { askNonEmpty } from "./ui.ts";

/** The whole run. Succeeds with the number of execution phases when Claude Code reports 'finished' and the work review converges. */
export const run = (task: string): Effect.Effect<number, RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    const config = yield* RunConfig;
    const planner = yield* Planner;
    const decider = yield* Decider;
    /** A phase's body, with the Decider of that phase: a decision taken in it is recorded in it (D3). */
    const inPhase = (phase: Phase) => <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.provideService(body, Decider, decider.at(phase));
    yield* store.init(task);
    // The SDK does not report which model answered a Codex turn; the configured one is all that can be said.
    yield* ui.say(`Codex model: ${config.codexModel ?? "the default of the Codex login"}`);
    const withRequirements = config.questionPhase;
    if (withRequirements) yield* questionPhase(task).pipe(inPhase({ kind: "questions" }));

    /** How the previous execution phase and its work review ended; the next plan revision is written from it. */
    let previous: Readonly<{ stopped: boolean; workReview: WorkReviewEnd }> | null = null;
    for (let k = 1; ; k++) {
      const subject = planSubject(k, withRequirements);
      const reviewed = yield* Effect.gen(function* () {
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
          if ((yield* askDecision(`question from Claude Code: ${question.question.replace(/\s+/g, " ")}`, k, 0, question.options)) !== "") answered = true;
        }
        if (answered) yield* applyDecisions(subject);

        return yield* reviewLoop(subject);
      }).pipe(inPhase({ kind: "planning", n: k }));
      yield* ui.notify({ _tag: "PhaseEnded", phase: { kind: "planning", n: k }, result: reviewed.result });

      // Execution phase K.
      const stopped = yield* Effect.gen(function* () {
        yield* ui.notify({ _tag: "PhaseBegan", phase: { kind: "execution", n: k } });
        yield* ui.say(implementationBeganLine(k, config.execPermissionMode));
        const outcome = yield* planner.executing(executePrompt);
        yield* store.saveExecution(k, outcome);
        yield* store.checkpoint({ subject: "execution", phase: k, round: 0, stage: "executed" });
        yield* ui.notify({ _tag: "ExecutionEnded", phase: k, outcome });
        yield* ui.notify({ _tag: "PhaseEnded", phase: { kind: "execution", n: k }, result: outcome.status });
        yield* ui.say(implementationEndedLine(k, outcome.status));
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
        return stopped;
      }).pipe(inPhase({ kind: "execution", n: k }));

      // Work review K, after every execution phase whatever its status (behaviour 12).
      const work = yield* Effect.gen(function* () {
        yield* ui.notify({ _tag: "PhaseBegan", phase: { kind: "work", n: k } });
        yield* ui.say(`\nWork review ${k}: Codex reviews the changes to the project since the run began ...`);
        return yield* reviewLoop(workSubject(k, withRequirements));
      }).pipe(inPhase({ kind: "work", n: k }));
      yield* ui.notify({ _tag: "PhaseEnded", phase: { kind: "work", n: k }, result: work.result });
      // The run is finished only when Claude Code reported finished and the work review converged.
      if (!stopped && work.result === "converged") return k;
      previous = { stopped, workReview: work.result === "converged" ? "converged" : { revisedInRound: work.round } };
    }
  });
