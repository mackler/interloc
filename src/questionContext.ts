// The context call (S9, decision Q1): a fresh Claude Code session, which may read the project and change nothing, writes the context paragraph and the terms of a
// question the program composed itself, under the rules of every question; a reply that breaks them gets the repair
// turns of behaviour 10, and a call that cannot be made or repaired leaves the program's own paragraph (S10, G-R1-1).

import { Effect, Result } from "effect";
import { QuestionInvalid, type RunError } from "./errors.ts";
import { type ContextRequest, contextFallbackNote, contextPrompt, fallbackContext, questionRepairPrompt } from "./prompts.ts";
import { describe } from "./errors.ts";
import { type ContextWritten, questionProblems } from "./question.ts";
import { planningCall, type Validation } from "./review.ts";
import * as S from "./schema.ts";
import { type Decider, Planner, type RunConfig, Store, type Ui } from "./services.ts";

/** The reply's context and terms under the rules of every question, the program's question and options fixed (scope "context"). */
export const contextValidation =
  (request: ContextRequest): Validation<S.QuestionContext> =>
  (reply) => {
    const problems = questionProblems({ context: reply.context, question: request.question, terms: reply.terms, options: request.options, details: `${request.details}\n${request.facts}` }, "context");
    if (problems.length === 0) return Result.succeed({ value: reply, notes: [] });
    const questions = [{ where: "the context of the question", problems }];
    return Result.fail({ error: new QuestionInvalid({ questions }), repair: questionRepairPrompt(questions) });
  };

/** The program's own paragraph (S10), marked as the program's. */
export const programWritten = (request: ContextRequest): ContextWritten => ({ context: { text: fallbackContext(request.origin), by: "program" }, terms: [] });

/**
 * Writes a question's context in a fresh session, which may read the project and change nothing (S33): the agent's
 * paragraph and terms, or, when the call fails for any reason but the user's stop or a change the guards find, the
 * program's paragraph with a note in conversation.md, so that the question always reaches the user.
 */
export const writeContext = (task: string, request: ContextRequest): Effect.Effect<ContextWritten, RunError, Store | Planner | Decider | Ui | RunConfig> =>
  Effect.gen(function* () {
    const planner = yield* (yield* Planner).fresh;
    // S33: it may read the project and change nothing; the project and the guarded records are compared after the call.
    const written = yield* planningCall(contextPrompt(task, request), S.QuestionContext, "context", "readProject", contextValidation(request)).pipe(Effect.provideService(Planner, planner));
    return { context: { text: written.output.context, by: "agent" as const }, terms: written.output.terms };
  }).pipe(
    Effect.catch((error: RunError): Effect.Effect<ContextWritten, RunError, Store> =>
      error._tag === "UserStopped" || error._tag === "Interrupted" || error._tag === "ProjectChanged" || error._tag === "RecordsChanged"
        ? Effect.fail(error)
        : Effect.gen(function* () {
            yield* (yield* Store).converse(contextFallbackNote(describe(error)));
            return programWritten(request);
          }),
    ),
  );
