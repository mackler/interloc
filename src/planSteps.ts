// The steps of the plan during an execution call (issue #6, Q2, Q3, Q8, G-R1-2): the answer to each report_step call,
// and the plan when the call has ended. The plan is loaded once when the execution phase begins and held; every report
// is recorded on the held plan and written, and the end writes it again, so an edit of plan.json or plan.md during the
// call by any means is never taken in (P1-R1-4).

import { Effect, Option, Ref, Result, Semaphore } from "effect";
import type { RunError } from "./errors.ts";
import { endExecution, recordStep } from "./plan.ts";
import { stepRecordedText, unknownStepText } from "./prompts.ts";
import type { RecordedPlan } from "./schema.ts";
import { type StepReporter, Store, Ui } from "./services.ts";
import type { StepReport } from "./uiEvents.ts";

/** The reporter of execution phase k, and what is done when its call has ended. */
export type ExecutionSteps = Readonly<{ report: StepReporter; end: Effect.Effect<void, RunError> }>;

const idsOf = (plan: RecordedPlan | null): readonly string[] => (plan === null ? [] : plan.stages.flatMap((s) => s.steps.map((st) => st.id)));

/**
 * The steps of execution phase k over the plan as it stands when the phase begins. Reports are serialized, so that
 * concurrent tool calls lose none. The end turns every started step unfinished (G-R1-2) and always writes the held plan,
 * notifying it only when a status changed.
 */
export const executionSteps = (phase: number): Effect.Effect<ExecutionSteps, RunError, Store | Ui> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    const held = yield* Ref.make(Option.getOrNull(yield* store.loadPlan()));
    const lock = yield* Semaphore.make(1);
    // Issue #53: the notification names the report that caused it; the end's names none.
    const write = (plan: RecordedPlan, notify: boolean, step: StepReport | null) =>
      store.savePlan(plan).pipe(Effect.andThen(notify ? ui.notify({ _tag: "PlanChanged", phase, plan, step }) : Effect.void));
    const report: StepReporter = (id, status) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const plan = yield* Ref.get(held);
          const recorded = plan === null ? null : recordStep(plan, id, status);
          if (recorded === null || Result.isFailure(recorded)) return { text: unknownStepText(id, idsOf(plan)), isError: true };
          yield* Ref.set(held, recorded.success);
          yield* write(recorded.success, true, { id, status });
          return { text: stepRecordedText(id, status), isError: false };
        }),
      );
    const end = lock.withPermits(1)(
      Effect.gen(function* () {
        const plan = yield* Ref.get(held);
        if (plan === null) return;
        const ended = endExecution(plan);
        yield* Ref.set(held, ended);
        yield* write(ended, JSON.stringify(ended) !== JSON.stringify(plan), null);
      }),
    );
    return { report, end };
  });
