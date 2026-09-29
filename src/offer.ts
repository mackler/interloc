// The offer of decision support ("Help me decide", D2 of the decision-support plan): a question with two or more options
// carries it, whatever interface asks. Separate from src/decision.ts, which runs the loop, so that the places that ask
// (src/review.ts, src/conversation.ts, src/claude.ts) do not import the loop (no import cycle).

import { Effect } from "effect";
import type { RunError } from "./errors.ts";
import { chooseOption, isDecide, parseExtraRounds, parseTransportAnswer, parseUnchangedAnswer } from "./input.ts";
import * as prompts from "./prompts.ts";
import type { OptionAnswer, PresentedQuestion, QuestionContextText, QuestionOrigin, Term } from "./question.ts";
import { renderChoice, renderQuestionRecord } from "./render.ts";
import { Decider, Store, Ui } from "./services.ts";

// ---- the offer (D2) ------------------------------------------------------------------------------------

/**
 * An option of a question, with the answer the user gives to choose it (S8: its exact text, or any number he types) and
 * the answers that choose it (P1-R1-4). Each `answer` is one that `matches` accepts, which test/offer.test.ts asserts.
 */
export type OfferedOption = Readonly<{ label: string; description: string; answer: OptionAnswer; matches: (answer: string) => boolean }>;
/** A question before it is numbered (S7): everything the user is shown of it but its number. */
export type QuestionDraft = Readonly<{
  origin: QuestionOrigin;
  context: QuestionContextText;
  terms: readonly Term[];
  question: string;
  options: readonly OfferedOption[];
  details?: string;
  /**
   * A question the program composed asks a context call for its context and terms (S9, decision Q1): the facts of the
   * case in prose beside `details`. Absent: the draft's own context stands.
   */
  explain?: string;
  decision: number | null;
}>;
/** The fixed context paragraph of a question the program composes (S7, S10), marked as the program's. */
export const programContext = (origin: QuestionOrigin): QuestionContextText => ({ text: prompts.fallbackContext(origin), by: "program" });
/** An agent's context paragraph; the program's own paragraph where the agent wrote none. */
export const agentContext = (text: string, origin: QuestionOrigin): QuestionContextText => (text.trim() === "" ? programContext(origin) : { text, by: "agent" });
/**
 * What a decision's analysis is asked about: the question, or for a reply to Claude Code's message in the clarification
 * the message itself, which is that question's context and what its numbered answers answer.
 */
export const decisionQuestionOf = (draft: QuestionDraft): string => (draft.origin.kind === "reply" ? draft.context.text : draft.question);
/** The question as the user is shown it, with its number in the run. */
export const presentedQuestion = (draft: QuestionDraft, number: number): PresentedQuestion => ({
  number,
  origin: draft.origin,
  context: draft.context,
  terms: draft.terms,
  question: draft.question,
  options: draft.options.map((o) => ({ label: o.label, description: o.description, answer: o.answer })),
  details: draft.details ?? "",
  decision: draft.decision,
});

/** Options chosen by their number or their exact label: the interview, a relayed question, a pause, a plan writer's question. */
export const numberedOptions = (options: readonly Readonly<{ label: string; description: string }>[]): readonly OfferedOption[] =>
  options.map((o, i) => ({ label: o.label, description: o.description, answer: { token: String(i + 1) }, matches: (answer: string) => chooseOption(answer, options.length) === i || answer.trim() === o.label }));
/** A permission request: y allows, and anything else denies (the prompt's own rule); n is the answer shown for the denial. */
export const permissionOptions: readonly OfferedOption[] = [
  { label: prompts.PERMISSION_ALLOW, description: prompts.PERMISSION_ALLOW_DESCRIPTION, answer: { token: "y" }, matches: (answer) => answer.trim().toLowerCase() === "y" },
  { label: prompts.PERMISSION_DENY, description: prompts.PERMISSION_DENY_DESCRIPTION, answer: { token: "n" }, matches: (answer) => answer.trim().toLowerCase() !== "y" },
];
/** The pause of issue #30: Retry, Proceed and Stop, each chosen by the answers parseUnchangedAnswer reads as it. */
export const unchangedOptions = (interview: boolean): readonly OfferedOption[] => {
  const d = prompts.unchangedOptionDescriptions(interview);
  return [
    { label: prompts.UNCHANGED_RETRY, description: d.retry, answer: { token: prompts.UNCHANGED_ANSWERS.retry }, matches: (answer: string) => parseUnchangedAnswer(answer) === "retry" },
    { label: prompts.UNCHANGED_PROCEED, description: d.proceed, answer: { token: prompts.UNCHANGED_ANSWERS.proceed }, matches: (answer: string) => parseUnchangedAnswer(answer) === "proceed" },
    { label: prompts.UNCHANGED_STOP, description: d.stop, answer: { token: prompts.UNCHANGED_ANSWERS.stop }, matches: (answer: string) => parseUnchangedAnswer(answer) === "stop" },
  ];
};
/** The pause of issue #26: Retry again and Stop, each chosen by the answers parseTransportAnswer reads as it. */
export const transportOptions = (): readonly OfferedOption[] => {
  const d = prompts.transportOptionDescriptions();
  return [
    { label: prompts.TRANSPORT_RETRY_AGAIN, description: d.retry, answer: { token: prompts.TRANSPORT_ANSWERS.retry }, matches: (answer: string) => parseTransportAnswer(answer) === "retry" },
    { label: prompts.TRANSPORT_STOP, description: d.stop, answer: { token: prompts.TRANSPORT_ANSWERS.stop }, matches: (answer: string) => parseTransportAnswer(answer) === "stop" },
  ];
};
/**
 * The cycle limit (decision Q6): p proceeds where offered, a number adds cycles, and every other answer stops the run
 * (the review loop halts on it), so "2" is never read as the second option.
 */
export const limitOptions = (proceed: string | null): readonly OfferedOption[] => {
  const d = prompts.limitOptionDescriptions(proceed);
  const proceeds = (answer: string) => proceed !== null && answer === prompts.LIMIT_ANSWERS.proceed;
  const more = (answer: string) => parseExtraRounds(answer) !== null;
  return [
    ...(proceed === null ? [] : [{ label: prompts.LIMIT_PROCEED, description: d.proceed, answer: { token: prompts.LIMIT_ANSWERS.proceed }, matches: proceeds }]),
    { label: prompts.LIMIT_STOP, description: d.stop, answer: { token: prompts.LIMIT_ANSWERS.stop }, matches: (answer: string) => !proceeds(answer) && !more(answer) },
    { label: prompts.LIMIT_MORE, description: d.more, answer: { numeric: true }, matches: more },
  ];
};

/** The context and terms a context call writes for a question the program composed (S9), before it is presented. */
const explain = (draft: QuestionDraft, facts: string) =>
  Effect.gen(function* () {
    const decider = yield* Decider;
    const options = draft.options.map((o) => ({ label: o.label, description: o.description }));
    return yield* decider.explain({ origin: draft.origin, decision: draft.decision, question: draft.question, options, details: draft.details ?? "", facts });
  });

/**
 * Asks a question (S7), the one way a question reaches the user: it takes the question's number in the run, presents
 * the question (the page's event, which the terminal prints) and records it in conversation.md, then asks with the
 * kind's input hint. With two or more options the hint carries the offer of decision support (D2): "/decide" runs a
 * decision loop, shows its analysis, presents the question again and asks again. Any other answer is returned as
 * typed; after an analysis it is recorded as the choice of every decision made for this question (decision Q4), with
 * the option it chose. An answer that `acceptable` rejects (a blank reply where one is required) is neither returned
 * nor recorded: the question is presented again and asked again (W1-R1-1, W1-R1-2), with or without options.
 */
export const askOffering = <E>(
  ask: (prompt: string) => Effect.Effect<string, E>,
  hint: string,
  draft: QuestionDraft,
  acceptable: (answer: string) => boolean = () => true,
): Effect.Effect<string, E | RunError, Decider | Store | Ui> =>
  Effect.gen(function* () {
    const ui = yield* Ui;
    const store = yield* Store;
    const explained = draft.explain === undefined ? draft : { ...draft, ...(yield* explain(draft, draft.explain)) };
    const question = presentedQuestion(explained, yield* ui.nextQuestion);
    const present = ui.notify({ _tag: "QuestionPresented", question });
    yield* present;
    yield* store.converse(renderQuestionRecord(question));
    // The page keeps a decision's analysis for the question asked again (W3-R1-1).
    const rejected = ui.notify({ _tag: "AnswerRejected" }).pipe(Effect.andThen(present));
    if (draft.options.length < 2) {
      for (;;) {
        const answer = yield* ask(hint);
        if (acceptable(answer)) return answer;
        yield* rejected;
      }
    }
    const decider = yield* Decider;
    const options = draft.options.map((o) => ({ label: o.label, description: o.description }));
    const decisions: number[] = [];
    for (;;) {
      const answer = yield* ask(prompts.withOffer(hint));
      if (isDecide(answer)) {
        const asked = decisionQuestionOf(draft);
        const outcome = yield* decider.decide({ question: asked, options, number: question.number });
        decisions.push(outcome.decision);
        yield* ui.notify({ _tag: "DecisionAnalyzed", decision: outcome.decision, question: asked, presented: question, options, analysis: outcome.analysis });
        yield* present;
        continue;
      }
      if (!acceptable(answer)) {
        yield* rejected;
        continue;
      }
      const option = draft.options.find((o) => o.matches(answer))?.label ?? null;
      for (const k of decisions) {
        yield* store.saveChoice(k, { answer, option });
        yield* store.converse(renderChoice(k, answer, option));
      }
      return answer;
    }
  });
