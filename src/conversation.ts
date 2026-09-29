// The interview: a conversation between the user and Claude Code in the program's terminal. Separate from
// src/interview.ts (the question phase) so that src/subjects.ts can use it without an import cycle (finding 28).

import { Effect, Result } from "effect";
import type { RunError } from "./errors.ts";
import { parseInterviewMessage } from "./input.ts";
import * as prompts from "./prompts.ts";
import { interviewSays, recordHeading } from "./render.ts";
import { planningCall, questionsValidation, type Validation } from "./review.ts";
import * as S from "./schema.ts";
import { clarificationCount, normalizeTurn, type TurnVariant } from "./schemaNormalize.ts";
import { type Services, Store, Ui } from "./services.ts";
import { agentContext, askOffering, numberedOptions, programContext, type QuestionDraft } from "./offer.ts";
import type { QuestionOrigin } from "./question.ts";
import { numberedOptionLabels } from "./userPrompts.ts";
import type { InterviewStage } from "./uiEvents.ts";

/**
 * The validation of an interview turn (S16, Q12): the question it asks now, when its id is not one of questions.json
 * (a follow-up, an accepted requirements issue), under the rules; an agreed question, whose presentation comes from the
 * records (S18), and a turn that asks nothing are not checked.
 */
export const turnValidation =
  (recorded: readonly string[]): Validation<S.InterviewTurn> =>
  (turn) => {
    const current = turn.current_question;
    if (current.id.trim() === "" || recorded.includes(current.id)) return Result.succeed({ value: turn, notes: [] });
    return questionsValidation((t: S.InterviewTurn) => [{ where: current.id, question: { context: t.current_question.context, question: t.current_question.text, terms: t.current_question.terms, options: t.current_question.options } }])(turn);
  };

/**
 * The question an interview turn asks (S7): the question it names now, with its context, terms and options, as an
 * agreed question or a follow-up; a turn that names none asks for the user's reply to its message, which is then the
 * context. Options the turn does not give are read from its message's numbered answers (W2-R1-2).
 */
export const turnDraft = (turn: TurnVariant, agreed: readonly string[]): QuestionDraft => {
  const current = turn.current;
  if (current.text.trim() === "") return { origin: { kind: "reply" }, context: { text: turn.message, by: "agent" }, terms: [], question: prompts.REPLY_QUESTION, options: numberedOptions(numberedOptionLabels(turn.message)), decision: null };
  const origin: QuestionOrigin = agreed.includes(current.id) ? { kind: "clarification", id: current.id } : { kind: "followUp", id: current.id };
  const options = current.options.length > 0 ? current.options : numberedOptionLabels(turn.message);
  return { origin, context: agentContext(current.context, origin), terms: current.terms, question: current.text, options: numberedOptions(options), decision: null };
};

/**
 * A conversation between the user and Claude Code in the program's terminal. It ends when Claude Code
 * reports completion and the user confirms the summary, which the program writes to requirements.md.
 */
export const interview = (opening: string, stage: InterviewStage, agreed: readonly string[]): Effect.Effect<void, RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    // The user reads "Clarification" (issue #21); conversation.md, a record, keeps its heading.
    const heading = prompts.clarificationHeading(stage);
    // Each interface renders its own help (finding 8 of docs/gui-review.md): the terminal its """ convention, the page Shift+Enter.
    yield* ui.notify({ _tag: "InterviewOpened", heading, stage, total: clarificationCount(agreed, [], []).total });
    yield* store.converse(`## ${recordHeading(stage)}\n\n`);
    // S16: the questions of questions.json were reviewed; any other question a turn asks is held to the rules here.
    const recorded = (yield* store.loadQuestions()).questions.map((q) => q.id);
    let prompt = opening;
    for (;;) {
      const turn = normalizeTurn((yield* planningCall(prompt, S.InterviewTurn, "interview", "records", turnValidation(recorded))).output);
      const [messageLine] = interviewSays(turn);
      yield* ui.notify({ _tag: "InterviewTurn", heading, message: turn.message, summary: turn.kind === "summary_proposed" ? turn.summary : null, ...clarificationCount(agreed, turn.asked, turn.answered) });
      yield* ui.say(messageLine);
      yield* store.converse(`**Claude Code:** ${turn.message}\n\n`);

      if (turn.kind === "summary_proposed") {
        // S7: the summary is read beside the question that confirms it, after the program's paragraph.
        const origin: QuestionOrigin = { kind: "confirmSummary" };
        const draft: QuestionDraft = { origin, context: programContext(origin), terms: [], question: prompts.CONFIRM_SUMMARY_QUESTION, options: [], details: turn.summary.trim(), decision: null };
        const reply = parseInterviewMessage(yield* askOffering((m) => ui.askMessage(m), prompts.confirmSummaryPrompt, draft));
        if (reply.kind !== "text") {
          yield* store.writeRequirements(turn.summary.trimEnd() + "\n");
          yield* store.converse(`**User:** confirmed the summary.\n\n### Confirmed summary\n\n${turn.summary}\n\n`);
          return;
        }
        yield* store.converse(`**User:** ${reply.text}\n\n`);
        prompt = prompts.interviewNotConfirmed(reply.text);
        continue;
      }

      // A blank message is asked again inside the offer, so that it is never recorded as the choice (W1-R1-1).
      const reply = parseInterviewMessage(yield* askOffering((m) => ui.askMessage(m), prompts.interviewMessagePrompt, turnDraft(turn, agreed), (m) => m !== ""));
      if (reply.kind === "empty") continue;
      yield* store.converse(`**User:** ${reply.kind === "done" ? "/done" : reply.text}\n\n`);
      prompt = reply.kind === "done" ? prompts.interviewDonePrompt : prompts.interviewUserMessage(reply.text);
    }
  });

