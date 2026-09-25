// The question phase: question list, its review, the interview, and the review of its result.

import { Effect } from "effect";
import type { RunError } from "./errors.ts";
import { parseInterviewMessage } from "./input.ts";
import * as prompts from "./prompts.ts";
import { planningCall, reviewLoop } from "./review.ts";
import * as S from "./schema.ts";
import type { QuestionList } from "./schema.ts";
import { type Services, Store, Ui } from "./services.ts";
import { questionSubject, requirementsSubject, writeQuestions } from "./subjects.ts";
import { askNonEmpty } from "./ui.ts";

/**
 * A conversation between the user and Claude Code in the program's terminal. It ends when Claude Code
 * reports completion and the user confirms the summary, which the program writes to requirements.md.
 */
export const interview = (opening: string, heading: string): Effect.Effect<void, RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    yield* ui.say(`\n${heading}. Commands: /done = end the interview; /quit = end the run; """ on its own line starts and ends a message of several lines.`);
    yield* store.converse(`## ${heading}\n\n`);
    let prompt = opening;
    for (;;) {
      const turn = (yield* planningCall(prompt, S.InterviewTurn, true)).output;
      yield* ui.say(`\n${turn.message_to_user}\n`);
      yield* store.converse(`**Claude Code:** ${turn.message_to_user}\n\n`);

      if (turn.complete && turn.summary.trim() !== "") {
        yield* ui.say(`Summary proposed by Claude Code:\n\n${turn.summary}\n`);
        const reply = parseInterviewMessage(yield* ui.askMessage("Enter = confirm the summary; any other text continues the conversation > "));
        if (reply.kind !== "text") {
          yield* store.writeText(store.requirements, turn.summary.trimEnd() + "\n");
          yield* store.converse(`**User:** confirmed the summary.\n\n### Confirmed summary\n\n${turn.summary}\n\n`);
          return;
        }
        yield* store.converse(`**User:** ${reply.text}\n\n`);
        prompt = prompts.interviewNotConfirmed(reply.text);
        continue;
      }

      const reply = parseInterviewMessage(yield* askNonEmpty((p) => ui.askMessage(p), "You > "));
      if (reply.kind === "empty") continue;
      yield* store.converse(`**User:** ${reply.kind === "done" ? "/done" : reply.text}\n\n`);
      prompt = reply.kind === "done" ? prompts.interviewDonePrompt : prompts.interviewUserMessage(reply.text);
    }
  });

/** Runs before planning phase 1 and ends with requirements.md written. */
export const questionPhase = (task: string): Effect.Effect<void, RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;

    yield* ui.say("Question phase: Claude Code generates the question list ...");
    const generated = yield* planningCall(prompts.questionListPrompt(task), S.QuestionList);
    yield* writeQuestions(store, task, generated.output);
    yield* store.converse(`## Question list proposed by Claude Code\n\n${renderQuestions(generated.output)}\n`);

    yield* reviewLoop(questionSubject(store, task));

    const agreed = (yield* store.loadQuestions()).questions;
    yield* store.converse(`## Agreed question list\n\n${renderQuestions({ questions: agreed })}\n`);

    if (agreed.length === 0) {
      const first = yield* ui.askMessage("\nClaude Code and Codex agree that no question is needed. Enter = start planning; any other text opens a conversation with Claude Code > ");
      if (first === "" || first === "/done") {
        yield* store.writeText(store.requirements, `# Requirements\n\n## Task\n\n${task}\n\nNo question was needed, and the user added no information.\n`);
        yield* store.converse("**User:** started planning without a conversation.\n\n");
        return;
      }
      yield* store.converse(`**User:** ${first}\n\n`);
      yield* interview(prompts.interviewOpenEmptyPrompt(first), "Conversation before planning");
    } else {
      yield* ui.say(`\nThe agreed list contains ${agreed.length} question(s).`);
      yield* interview(prompts.interviewOpenPrompt, "Interview");
    }

    yield* reviewLoop(requirementsSubject(store));
  });

function renderQuestions(list: QuestionList): string {
  if (list.questions.length === 0) return "The list is empty.\n";
  return list.questions
    .map((q) => {
      const answers = q.proposed_answers.map((a) => `  - ${a.label}: ${a.description}${a.label === q.default_answer ? " (default)" : ""}`).join("\n");
      return `- **[${q.id}]** ${q.question}\n  Reason: ${q.reason}\n${answers}`;
    })
    .join("\n") + "\n";
}
