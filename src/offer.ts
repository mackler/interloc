// The offer of decision support ("Help me Decide", D2 of the decision-support plan): a question with two or more options
// carries it, whatever interface asks. Separate from src/decision.ts, which runs the loop, so that the places that ask
// (src/review.ts, src/conversation.ts, src/claude.ts) do not import the loop (no import cycle).

import { Effect } from "effect";
import type { RunError } from "./errors.ts";
import { chooseOption, isDecide, parseExtraRounds } from "./input.ts";
import * as prompts from "./prompts.ts";
import { renderChoice } from "./render.ts";
import { Decider, Store, Ui } from "./services.ts";

// ---- the offer (D2) ------------------------------------------------------------------------------------

/** An option of a question that carries the offer, with the answers that choose it (P1-R1-4). */
export type OfferedOption = Readonly<{ label: string; description: string; matches: (answer: string) => boolean }>;
export type OfferedQuestion = Readonly<{ question: string; options: readonly OfferedOption[] }>;

/** Options chosen by their number or their exact label: the interview, a relayed question, a pause, a plan writer's question. */
export const numberedOptions = (options: readonly Readonly<{ label: string; description: string }>[]): readonly OfferedOption[] =>
  options.map((o, i) => ({ label: o.label, description: o.description, matches: (answer: string) => chooseOption(answer, options.length) === i || answer.trim() === o.label }));
/** A permission request: y allows, and anything else denies (the prompt's own rule). */
export const permissionOptions: readonly OfferedOption[] = [
  { label: prompts.PERMISSION_ALLOW, description: prompts.PERMISSION_ALLOW_DESCRIPTION, matches: (answer) => answer.trim().toLowerCase() === "y" },
  { label: prompts.PERMISSION_DENY, description: prompts.PERMISSION_DENY_DESCRIPTION, matches: (answer) => answer.trim().toLowerCase() !== "y" },
];
/**
 * The cycle limit (decision Q6): p proceeds where offered, a number adds cycles, and every other answer stops the run
 * (the review loop halts on it), so "2" is never read as the second option.
 */
export const limitOptions = (proceed: string | null): readonly OfferedOption[] => {
  const d = prompts.limitOptionDescriptions(proceed);
  const proceeds = (answer: string) => proceed !== null && answer === "p";
  const more = (answer: string) => parseExtraRounds(answer) !== null;
  return [
    ...(proceed === null ? [] : [{ label: prompts.LIMIT_PROCEED, description: d.proceed, matches: proceeds }]),
    { label: prompts.LIMIT_STOP, description: d.stop, matches: (answer: string) => !proceeds(answer) && !more(answer) },
    { label: prompts.LIMIT_MORE, description: d.more, matches: more },
  ];
};

/**
 * Asks a question with the offer (D2). Fewer than two options: the ask unchanged. Otherwise the prompt carries the
 * offer; "/decide" runs a decision loop, shows its analysis, restores the question's presentation (`present`, P1-R1-3)
 * and asks again. Any other answer is returned as typed; after an analysis it is recorded as the choice of every
 * decision made for this question (decision Q4), with the option it chose.
 */
export const askOffering = <E>(ask: (prompt: string) => Effect.Effect<string, E>, prompt: string, question: OfferedQuestion, present: Effect.Effect<void>): Effect.Effect<string, E | RunError, Decider | Store | Ui> =>
  Effect.gen(function* () {
    if (question.options.length < 2) return yield* ask(prompt);
    const decider = yield* Decider;
    const store = yield* Store;
    const ui = yield* Ui;
    const options = question.options.map((o) => ({ label: o.label, description: o.description }));
    const decisions: number[] = [];
    for (;;) {
      const answer = yield* ask(prompts.withOffer(prompt));
      if (isDecide(answer)) {
        const outcome = yield* decider.decide({ question: question.question, options });
        decisions.push(outcome.decision);
        yield* ui.notify({ _tag: "DecisionAnalyzed", decision: outcome.decision, question: question.question, options, analysis: outcome.analysis });
        yield* present;
        continue;
      }
      const option = question.options.find((o) => o.matches(answer))?.label ?? null;
      for (const k of decisions) {
        yield* store.saveChoice(k, { answer, option });
        yield* store.converse(renderChoice(k, answer, option));
      }
      return answer;
    }
  });
