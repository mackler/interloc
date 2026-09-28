// The three subjects of the review procedure.

import { Effect } from "effect";
import { phaseOf, recordPath, type SubjectId } from "./artifacts.ts";
import { interview } from "./conversation.ts";
import type { RunError } from "./errors.ts";
import * as prompts from "./prompts.ts";
import { subjectHeading } from "./render.ts";
import type { Subject } from "./review.ts";
import * as S from "./schema.ts";
import type { PlannerResponse, PlanWriteResult, QuestionList, QuestionListResponse } from "./schema.ts";
import { normalizeQuestionList } from "./schemaNormalize.ts";
import { Store } from "./services.ts";

/** Records the list as questions.json after normalisation: an invalid list halts, and a dropped default is noted in the conversation. */
export const writeQuestions = (task: string, list: QuestionList): Effect.Effect<void, RunError, Store> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const normalized = yield* Effect.fromResult(normalizeQuestionList(list));
    for (const note of normalized.notes) yield* store.converse(`**Note:** ${note}\n\n`);
    yield* store.saveQuestions(task, normalized.questions);
  });

/** The question list. Claude Code returns the amended list, and the program writes it to questions.json. */
export function questionSubject(task: string): Subject<QuestionListResponse, QuestionList> {
  const id = "questions" as const;
  return {
    id,
    phase: phaseOf(id),
    heading: subjectHeading(id),
    fileLabel: "questions.json",
    reviewPrompt: prompts.questionReviewPrompt,
    respond: { prompt: prompts.questionRespondPrompt, schema: S.QuestionListResponse, after: (output) => writeQuestions(task, output), capability: "records" },
    applyDecisions: { prompt: prompts.questionApplyDecisionsPrompt, schema: S.QuestionList, after: (output) => writeQuestions(task, output) },
    amend: null,
    proceed: prompts.PROCEED_TO_CLARIFICATION,
    leaveOnAcceptance: false,
    leaveOnDecision: false,
    prepare: null,
  };
}

/** The confirmed interview result. An accepted issue is put to the user in a second interview. */
export function requirementsSubject(): Subject<PlannerResponse, PlanWriteResult> {
  const id = "requirements" as const;
  return {
    id,
    phase: phaseOf(id),
    heading: subjectHeading(id),
    fileLabel: "requirements.md",
    reviewPrompt: prompts.requirementsReviewPrompt,
    respond: { prompt: prompts.requirementsRespondPrompt, schema: S.PlannerResponse, after: null, capability: "records" },
    applyDecisions: { prompt: prompts.requirementsApplyDecisionsPrompt, schema: S.PlanWriteResult, after: null },
    amend: (_review, response, round) => {
      const ids = response.dispositions.filter((d) => d.action === "accepted" || d.action === "partially_accepted").map((d) => d.id);
      if (ids.length === 0) return Effect.succeed(undefined);
      return interview(prompts.interviewGapsPrompt(recordPath({ kind: "review", subject: id, round }), ids), "followUp", ids);
    },
    proceed: prompts.PROCEED_TO_PLANNING,
    leaveOnAcceptance: false,
    leaveOnDecision: false,
    prepare: null,
  };
}

export function planSubject(phase: number, withRequirements: boolean): Subject<PlannerResponse, PlanWriteResult> {
  const id = { plan: phase };
  return {
    id,
    phase: phaseOf(id),
    heading: subjectHeading(id),
    fileLabel: "plan.md",
    reviewPrompt: (round) => prompts.planReviewPrompt(phase, round, withRequirements),
    respond: { prompt: (round) => prompts.planRespondPrompt(phase, round), schema: S.PlannerResponse, after: null, capability: "records" },
    applyDecisions: { prompt: prompts.planApplyDecisionsPrompt, schema: S.PlanWriteResult, after: null },
    amend: null,
    proceed: prompts.PROCEED_TO_IMPLEMENTATION,
    leaveOnAcceptance: false,
    leaveOnDecision: false,
    prepare: null,
  };
}

/**
 * The work of execution phase k (the work review, plan 2.7): Codex reviews changes.diff and the project; an accepted
 * issue or a user decision leaves for a planning phase; there is no proceed choice; changes.diff is rewritten before
 * every round's review.
 */
export function workSubject(phase: number, withRequirements: boolean): Subject<PlannerResponse, PlanWriteResult> {
  const id = { work: phase };
  return {
    id,
    phase: phaseOf(id),
    heading: subjectHeading(id),
    fileLabel: "changes.diff",
    reviewPrompt: (round) => prompts.workReviewPrompt(phase, round, withRequirements),
    respond: { prompt: (round, context) => prompts.workRespondPrompt(phase, round, context), schema: S.PlannerResponse, after: null, capability: "readOnly" },
    // Never issued: leaveOnDecision ends the loop instead of a planning call (G-R1-1); typed as the plan's.
    applyDecisions: { prompt: prompts.planApplyDecisionsPrompt, schema: S.PlanWriteResult, after: null },
    amend: null,
    proceed: null,
    leaveOnAcceptance: true,
    leaveOnDecision: true,
    prepare: Effect.gen(function* () {
      const store = yield* Store;
      yield* store.changeRecord(phase);
    }),
  };
}
