// The question phase: question list, its review, the interview (src/conversation.ts), and the review of its result.

import { Effect } from "effect";
import type { RunError } from "./errors.ts";
import { interview } from "./conversation.ts";
import * as prompts from "./prompts.ts";
import { planningCall, reviewLoop } from "./review.ts";
import { renderQuestions } from "./render.ts";
import * as S from "./schema.ts";
import { type Services, Store, Ui } from "./services.ts";
import { questionSubject, requirementsSubject, writeQuestions } from "./subjects.ts";

/** Runs before planning phase 1 and ends with requirements.md written. */
export const questionPhase = (task: string): Effect.Effect<void, RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;

    yield* ui.say("Question phase: Claude Code generates the question list ...");
    const generated = yield* planningCall(prompts.questionListPrompt(task), S.QuestionList);
    yield* writeQuestions(task, generated.output);
    yield* store.converse(`## Question list proposed by Claude Code\n\n${renderQuestions(generated.output)}\n`);

    yield* reviewLoop(questionSubject(task));

    const agreed = (yield* store.loadQuestions()).questions;
    yield* store.converse(`## Agreed question list\n\n${renderQuestions({ questions: agreed })}\n`);

    if (agreed.length === 0) {
      const first = yield* ui.askMessage("\nClaude Code and Codex agree that no question is needed. Enter = start planning; any other text opens a conversation with Claude Code > ");
      if (first === "" || first === "/done") {
        yield* store.writeRequirements(`# Requirements\n\n## Task\n\n${task}\n\nNo question was needed, and the user added no information.\n`);
        yield* store.converse("**User:** started planning without a conversation.\n\n");
        return;
      }
      yield* store.converse(`**User:** ${first}\n\n`);
      yield* interview(prompts.interviewOpenEmptyPrompt(first), "Conversation before planning");
    } else {
      yield* ui.say(`\nThe agreed list contains ${agreed.length} question(s).`);
      yield* interview(prompts.interviewOpenPrompt, "Interview");
    }

    yield* reviewLoop(requirementsSubject());
  });
