// The question phase: question list, its review, the interview, and the review of its result.

import * as prompts from "./prompts.ts";
import { planningCall, reviewLoop, type Context } from "./review.ts";
import * as S from "./schema.ts";
import type { QuestionList } from "./schema.ts";
import { questionSubject, requirementsSubject, writeQuestions } from "./subjects.ts";

/**
 * A conversation between the user and Claude Code in the program's terminal. It ends when Claude Code
 * reports completion and the user confirms the summary, which the program writes to requirements.md.
 */
export async function interview(ctx: Context, opening: string, heading: string): Promise<void> {
  const { state, ui } = ctx;
  ui.say(`\n${heading}. Commands: /done = end the interview; /quit = end the run; """ on its own line starts and ends a message of several lines.`);
  state.converse(`## ${heading}\n\n`);
  let prompt = opening;
  for (;;) {
    const turn = (await planningCall(ctx, prompt, S.InterviewTurn, true)).output;
    ui.say(`\n${turn.message_to_user}\n`);
    state.converse(`**Claude Code:** ${turn.message_to_user}\n\n`);

    if (turn.complete && turn.summary.trim() !== "") {
      ui.say(`Summary proposed by Claude Code:\n\n${turn.summary}\n`);
      const reply = await ui.askMessage("Enter = confirm the summary; any other text continues the conversation > ");
      if (reply === "" || reply === "/done") {
        state.writeText(state.requirements, turn.summary.trimEnd() + "\n");
        state.converse(`**User:** confirmed the summary.\n\n### Confirmed summary\n\n${turn.summary}\n\n`);
        return;
      }
      state.converse(`**User:** ${reply}\n\n`);
      prompt = prompts.interviewNotConfirmed(reply);
      continue;
    }

    let reply = "";
    while (reply === "") reply = await ui.askMessage("You > ");
    state.converse(`**User:** ${reply}\n\n`);
    prompt = reply === "/done" ? prompts.interviewDonePrompt : prompts.interviewUserMessage(reply);
  }
}

/** Runs before planning phase 1. Returns true when requirements.md was written from a conversation. */
export async function questionPhase(ctx: Context, task: string): Promise<void> {
  const { state, ui } = ctx;

  ui.say("Question phase: Claude Code generates the question list ...");
  const generated = await planningCall(ctx, prompts.questionListPrompt(task), S.QuestionList);
  writeQuestions(state, task, generated.output);
  state.converse(`## Question list proposed by Claude Code\n\n${renderQuestions(generated.output)}\n`);

  await reviewLoop(ctx, questionSubject(state, task));

  const agreed = state.loadQuestions().questions;
  state.converse(`## Agreed question list\n\n${renderQuestions({ questions: agreed })}\n`);

  if (agreed.length === 0) {
    const first = await ui.askMessage("\nClaude Code and Codex agree that no question is needed. Enter = start planning; any other text opens a conversation with Claude Code > ");
    if (first === "" || first === "/done") {
      state.writeText(state.requirements, `# Requirements\n\n## Task\n\n${task}\n\nNo question was needed, and the user added no information.\n`);
      state.converse("**User:** started planning without a conversation.\n\n");
      return;
    }
    state.converse(`**User:** ${first}\n\n`);
    await interview(ctx, prompts.interviewOpenEmptyPrompt(first), "Conversation before planning");
  } else {
    ui.say(`\nThe agreed list contains ${agreed.length} question(s).`);
    await interview(ctx, prompts.interviewOpenPrompt, "Interview");
  }

  await reviewLoop(ctx, requirementsSubject(state));
}

function renderQuestions(list: QuestionList): string {
  if (list.questions.length === 0) return "The list is empty.\n";
  return list.questions
    .map((q) => {
      const answers = q.proposed_answers.map((a) => `  - ${a.label}: ${a.description}${a.label === q.default_answer ? " (default)" : ""}`).join("\n");
      return `- **[${q.id}]** ${q.question}\n  Reason: ${q.reason}\n${answers}`;
    })
    .join("\n") + "\n";
}
