// The interview: a conversation between the user and Claude Code in the program's terminal. Separate from
// src/interview.ts (the question phase) so that src/subjects.ts can use it without an import cycle (finding 28).

import { Effect } from "effect";
import type { RunError } from "./errors.ts";
import { parseInterviewMessage } from "./input.ts";
import * as prompts from "./prompts.ts";
import { interviewSays } from "./render.ts";
import { planningCall } from "./review.ts";
import * as S from "./schema.ts";
import { normalizeTurn } from "./schemaNormalize.ts";
import { type Services, Store, Ui } from "./services.ts";
import { askNonEmpty } from "./ui.ts";

/**
 * A conversation between the user and Claude Code in the program's terminal. It ends when Claude Code
 * reports completion and the user confirms the summary, which the program writes to requirements.md.
 */
export const interview = (opening: string, heading: string): Effect.Effect<void, RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    // Each interface renders its own help (finding 8 of docs/gui-review.md): the terminal its """ convention, the page Shift+Enter.
    yield* ui.notify({ _tag: "InterviewOpened", heading });
    yield* store.converse(`## ${heading}\n\n`);
    let prompt = opening;
    for (;;) {
      const turn = normalizeTurn((yield* planningCall(prompt, S.InterviewTurn, "interview")).output);
      const [messageLine, ...summaryLines] = interviewSays(turn);
      yield* ui.notify({ _tag: "InterviewTurn", heading, message: turn.message, summary: turn.kind === "summary_proposed" ? turn.summary : null });
      yield* ui.say(messageLine);
      yield* store.converse(`**Claude Code:** ${turn.message}\n\n`);

      if (turn.kind === "summary_proposed") {
        for (const line of summaryLines) yield* ui.say(line);
        const reply = parseInterviewMessage(yield* ui.askMessage(prompts.confirmSummaryPrompt));
        if (reply.kind !== "text") {
          yield* store.writeRequirements(turn.summary.trimEnd() + "\n");
          yield* store.converse(`**User:** confirmed the summary.\n\n### Confirmed summary\n\n${turn.summary}\n\n`);
          return;
        }
        yield* store.converse(`**User:** ${reply.text}\n\n`);
        prompt = prompts.interviewNotConfirmed(reply.text);
        continue;
      }

      const reply = parseInterviewMessage(yield* askNonEmpty((p) => ui.askMessage(p), prompts.interviewMessagePrompt));
      if (reply.kind === "empty") continue;
      yield* store.converse(`**User:** ${reply.kind === "done" ? "/done" : reply.text}\n\n`);
      prompt = reply.kind === "done" ? prompts.interviewDonePrompt : prompts.interviewUserMessage(reply.text);
    }
  });

