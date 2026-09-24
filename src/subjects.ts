// The three subjects of the review procedure.

import { Effect } from "effect";
import * as path from "node:path";
import { interview } from "./interview.ts";
import * as prompts from "./prompts.ts";
import type { Subject } from "./review.ts";
import * as S from "./schema.ts";
import type { PlannerResponse, QuestionList, QuestionListResponse } from "./schema.ts";
import type { StoreError, StoreShape } from "./services.ts";

export const writeQuestions = (store: StoreShape, task: string, list: QuestionList): Effect.Effect<void, StoreError> =>
  store.writeJson(store.questions, { task, questions: list.questions });

/** The question list. Claude Code returns the amended list, and the program writes it to questions.json. */
export function questionSubject(store: StoreShape, task: string): Subject<QuestionListResponse> {
  return {
    heading: "Question review",
    fileLabel: "questions.json",
    file: store.questions,
    logName: "questions-log.json",
    dirName: "question-review",
    phase: 0,
    reviewPrompt: prompts.questionReviewPrompt,
    respondPrompt: prompts.questionRespondPrompt,
    respondSchema: S.QuestionListResponse,
    applyDecisionsPrompt: prompts.questionApplyDecisionsPrompt,
    applyDecisionsSchema: S.QuestionList,
    afterPlannerCall: (output) => writeQuestions(store, task, output as QuestionList),
    proceedLabel: "proceed to the interview with the question list as it is",
  };
}

/** The confirmed interview result. An accepted issue is put to the user in a second interview. */
export function requirementsSubject(store: StoreShape): Subject {
  return {
    heading: "Requirements review",
    fileLabel: "requirements.md",
    file: store.requirements,
    logName: "requirements-log.json",
    dirName: "requirements-review",
    phase: 0,
    reviewPrompt: prompts.requirementsReviewPrompt,
    respondPrompt: prompts.requirementsRespondPrompt,
    respondSchema: S.PlannerResponse,
    applyDecisionsPrompt: prompts.requirementsApplyDecisionsPrompt,
    applyDecisionsSchema: S.PlanWriteResult,
    amend: (_review, response: PlannerResponse, round) => {
      const ids = response.dispositions.filter((d) => d.action === "accepted" || d.action === "partially_accepted").map((d) => d.id);
      if (ids.length === 0) return Effect.succeed(undefined);
      const reviewFile = path.join("plan-review", "requirements-review", `review-${round}.json`);
      return interview(prompts.interviewGapsPrompt(reviewFile, ids), "Second interview");
    },
    proceedLabel: "proceed to planning with the requirements as they are",
  };
}

export function planSubject(store: StoreShape, phase: number, withRequirements: boolean): Subject {
  return {
    heading: `Planning phase ${phase}`,
    fileLabel: "plan.md",
    file: store.plan,
    logName: "issue-log.json",
    dirName: `planning-${phase}`,
    phase,
    reviewPrompt: (round) => prompts.planReviewPrompt(phase, round, withRequirements),
    respondPrompt: (round) => prompts.planRespondPrompt(phase, round),
    respondSchema: S.PlannerResponse,
    applyDecisionsPrompt: prompts.planApplyDecisionsPrompt,
    applyDecisionsSchema: S.PlanWriteResult,
    proceedLabel: "proceed to execution with the plan as it is",
  };
}
