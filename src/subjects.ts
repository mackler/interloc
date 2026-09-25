// The three subjects of the review procedure.

import { Effect } from "effect";
import * as path from "node:path";
import { interview } from "./interview.ts";
import * as prompts from "./prompts.ts";
import { questionsFile } from "./records.ts";
import type { Subject } from "./review.ts";
import * as S from "./schema.ts";
import type { PlannerResponse, PlanWriteResult, QuestionList, QuestionListResponse } from "./schema.ts";
import { normalizeQuestionList } from "./schemaNormalize.ts";
import type { StoreShape } from "./services.ts";
import type { RunError } from "./errors.ts";

/** Records the list as questions.json after normalisation: an invalid list halts, and a dropped default is noted in the conversation. */
export const writeQuestions = (store: StoreShape, task: string, list: QuestionList): Effect.Effect<void, RunError> =>
  Effect.gen(function* () {
    const normalized = yield* Effect.fromResult(normalizeQuestionList(list));
    for (const note of normalized.notes) yield* store.converse(`**Note:** ${note}\n\n`);
    yield* store.writeJson(store.questions, questionsFile(task, normalized.questions));
  });

/** The question list. Claude Code returns the amended list, and the program writes it to questions.json. */
export function questionSubject(store: StoreShape, task: string): Subject<QuestionListResponse, QuestionList> {
  return {
    heading: "Question review",
    fileLabel: "questions.json",
    file: store.questions,
    logName: "questions-log.json",
    dirName: "question-review",
    phase: 0,
    reviewPrompt: prompts.questionReviewPrompt,
    respond: { prompt: prompts.questionRespondPrompt, schema: S.QuestionListResponse, after: (output) => writeQuestions(store, task, output) },
    applyDecisions: { prompt: prompts.questionApplyDecisionsPrompt, schema: S.QuestionList, after: (output) => writeQuestions(store, task, output) },
    amend: null,
    proceedLabel: "proceed to the interview with the question list as it is",
  };
}

/** The confirmed interview result. An accepted issue is put to the user in a second interview. */
export function requirementsSubject(store: StoreShape): Subject<PlannerResponse, PlanWriteResult> {
  return {
    heading: "Requirements review",
    fileLabel: "requirements.md",
    file: store.requirements,
    logName: "requirements-log.json",
    dirName: "requirements-review",
    phase: 0,
    reviewPrompt: prompts.requirementsReviewPrompt,
    respond: { prompt: prompts.requirementsRespondPrompt, schema: S.PlannerResponse, after: null },
    applyDecisions: { prompt: prompts.requirementsApplyDecisionsPrompt, schema: S.PlanWriteResult, after: null },
    amend: (_review, response, round) => {
      const ids = response.dispositions.filter((d) => d.action === "accepted" || d.action === "partially_accepted").map((d) => d.id);
      if (ids.length === 0) return Effect.succeed(undefined);
      const reviewFile = path.join("plan-review", "requirements-review", `review-${round}.json`);
      return interview(prompts.interviewGapsPrompt(reviewFile, ids), "Second interview");
    },
    proceedLabel: "proceed to planning with the requirements as they are",
  };
}

export function planSubject(store: StoreShape, phase: number, withRequirements: boolean): Subject<PlannerResponse, PlanWriteResult> {
  return {
    heading: `Planning phase ${phase}`,
    fileLabel: "plan.md",
    file: store.plan,
    logName: "issue-log.json",
    dirName: `planning-${phase}`,
    phase,
    reviewPrompt: (round) => prompts.planReviewPrompt(phase, round, withRequirements),
    respond: { prompt: (round) => prompts.planRespondPrompt(phase, round), schema: S.PlannerResponse, after: null },
    applyDecisions: { prompt: prompts.planApplyDecisionsPrompt, schema: S.PlanWriteResult, after: null },
    amend: null,
    proceedLabel: "proceed to execution with the plan as it is",
  };
}
