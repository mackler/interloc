// The three subjects of the review procedure.

import * as path from "node:path";
import { interview } from "./interview.ts";
import * as prompts from "./prompts.ts";
import type { Context, Subject } from "./review.ts";
import { planWriteSchema, plannerResponseSchema, questionListResponseSchema, questionListSchema } from "./schemas.ts";
import type { State } from "./state.ts";
import type { PlannerResponse, QuestionList, QuestionListResponse } from "./types.ts";

export function writeQuestions(state: State, task: string, list: QuestionList): void {
  state.writeJson(state.questions, { task, questions: list.questions });
}

/** The question list. Claude Code returns the amended list, and the program writes it to questions.json. */
export function questionSubject(state: State, task: string): Subject<QuestionListResponse> {
  return {
    heading: "Question review",
    fileLabel: "questions.json",
    file: state.questions,
    logName: "questions-log.json",
    dirName: "question-review",
    phase: 0,
    reviewPrompt: prompts.questionReviewPrompt,
    respondPrompt: prompts.questionRespondPrompt,
    respondSchema: questionListResponseSchema,
    applyDecisionsPrompt: prompts.questionApplyDecisionsPrompt,
    applyDecisionsSchema: questionListSchema,
    afterPlannerCall: (output) => writeQuestions(state, task, output as QuestionList),
    proceedLabel: "proceed to the interview with the question list as it is",
  };
}

/** The confirmed interview result. An accepted issue is put to the user in a second interview. */
export function requirementsSubject(state: State): Subject {
  return {
    heading: "Requirements review",
    fileLabel: "requirements.md",
    file: state.requirements,
    logName: "requirements-log.json",
    dirName: "requirements-review",
    phase: 0,
    reviewPrompt: prompts.requirementsReviewPrompt,
    respondPrompt: prompts.requirementsRespondPrompt,
    respondSchema: plannerResponseSchema,
    applyDecisionsPrompt: prompts.requirementsApplyDecisionsPrompt,
    applyDecisionsSchema: planWriteSchema,
    amend: async (ctx: Context, _review, response: PlannerResponse, round: number) => {
      const ids = response.dispositions.filter((d) => d.action === "accepted" || d.action === "partially_accepted").map((d) => d.id);
      if (ids.length === 0) return;
      const reviewFile = path.join("plan-review", "requirements-review", `review-${round}.json`);
      await interview(ctx, prompts.interviewGapsPrompt(reviewFile, ids), "Second interview");
    },
    proceedLabel: "proceed to planning with the requirements as they are",
  };
}

export function planSubject(state: State, phase: number, withRequirements: boolean): Subject {
  return {
    heading: `Planning phase ${phase}`,
    fileLabel: "plan.md",
    file: state.plan,
    logName: "issue-log.json",
    dirName: `planning-${phase}`,
    phase,
    reviewPrompt: (round) => prompts.planReviewPrompt(phase, round, withRequirements),
    respondPrompt: (round) => prompts.planRespondPrompt(phase, round),
    respondSchema: plannerResponseSchema,
    applyDecisionsPrompt: prompts.planApplyDecisionsPrompt,
    applyDecisionsSchema: planWriteSchema,
    proceedLabel: "proceed to execution with the plan as it is",
  };
}
