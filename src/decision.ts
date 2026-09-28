// Decision support ("Help me Decide", docs/decision-support-design.md): a decision loop analyzes the options of a
// question under docs/decision-making.md, reviewed by Codex in rounds like every other loop (reviewLoop), in a fresh
// Claude Code session (decision Q3). Decisions are numbered across the run; the loop sits inside the phase in which
// the question was asked and changes nothing about the phases.

import { Effect, Layer } from "effect";
import { validateAnalysis } from "./analysis.ts";
import type { RunError } from "./errors.ts";
import * as prompts from "./prompts.ts";
import { decisionAnalysisPrompt, decisionBeganLine } from "./prompts.ts";
import { chooseOption, isDecide, parseExtraRounds } from "./input.ts";
import { renderChoice, renderDecisionOpened, renderReferenceDropped } from "./render.ts";
import { planningCall, reviewLoop } from "./review.ts";
import * as S from "./schema.ts";
import type { DecisionAnalysis } from "./schema.ts";
import { Decider, type DecisionQuestion, type DeciderShape, Planner, type Reviewer, type RunConfig, type Services, Store, Ui } from "./services.ts";
import { decisionSubject } from "./subjects.ts";
import type { LoopResult } from "./uiEvents.ts";

export type DecisionEnd = Readonly<{ decision: number; question: DecisionQuestion; analysis: DecisionAnalysis; result: LoopResult }>;

/** The phase number a decision's loop records: 0 in Gather Requirements, the phase's number otherwise. */
export const phaseNumber = (phase: DecisionQuestion["phase"]): number => (phase.kind === "questions" ? 0 : phase.n);

/**
 * An analysis of decision k as the program accepts it, from the analysis call, a response or the application of the
 * user's decisions alike (P1-R2-1): validated against the question (an invalid one halts with AnalysisInvalid), each
 * dropped reference noted in conversation.md, and the normalized analysis written as the reviewed file.
 */
export const acceptAnalysis = (k: number, question: DecisionQuestion, analysis: DecisionAnalysis): Effect.Effect<void, RunError, Store> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const validated = yield* Effect.fromResult(validateAnalysis(question.options, analysis));
    for (const note of validated.notes) yield* store.converse(renderReferenceDropped(note.argument, note.named));
    yield* store.saveAnalysis(k, validated.analysis);
  });

/** One decision loop: the analysis, its review to convergence (or the user's proceed), and the analysis as it stands. */
export const decisionLoop = (format: string, task: string, question: DecisionQuestion): Effect.Effect<DecisionEnd, RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    // A fresh session (Q3): the run's main session, possibly paused mid-call, is neither resumed nor forked.
    const planner = yield* (yield* Planner).fresh;
    const k = yield* store.openDecision(question);
    yield* store.converse(renderDecisionOpened(k, question.question, question.options));
    yield* ui.say(decisionBeganLine(k));
    const context = { task, ...(yield* store.readContext()) };
    const accept = (analysis: DecisionAnalysis) => acceptAnalysis(k, question, analysis);
    const loop = Effect.gen(function* () {
      const written = yield* planningCall(decisionAnalysisPrompt(format, question, context), S.DecisionAnalysis);
      yield* store.saveAnalysisWrite(k, written.output);
      yield* accept(written.output);
      return yield* reviewLoop(decisionSubject(k, phaseNumber(question.phase), format, accept));
    }).pipe(Effect.provideService(Planner, planner));
    const end = yield* loop;
    return { decision: k, question, analysis: yield* store.loadAnalysis(k), result: end.result };
  });


// ---- the Decider (D3) --------------------------------------------------------------------------------

/** The services a decision loop runs over, captured when the Decider is built. */
export type DeciderDeps = Ui | Planner | Reviewer | Store | RunConfig;

/**
 * The Decider of a run: its loops run over the services captured here, so that `decide` requires nothing and an SDK
 * callback can run it. A loop's own prompts get the Decider of the same phase, so decisions nest.
 */
export const makeDecider = (task: string, format: string): Effect.Effect<DeciderShape, never, DeciderDeps> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<DeciderDeps>();
    const at = (phase: DecisionQuestion["phase"]): DeciderShape => {
      const self: DeciderShape = {
        at,
        decide: (request) =>
          decisionLoop(format, task, { phase, ...request }).pipe(
            Effect.map((end) => ({ decision: end.decision, analysis: end.analysis, result: end.result })),
            Effect.provideService(Decider, self),
            Effect.provideContext(context),
          ),
      };
      return self;
    };
    return at({ kind: "questions" });
  });
export const deciderLayer = (task: string, format: string): Layer.Layer<Decider, never, DeciderDeps> => Layer.effect(Decider, makeDecider(task, format));

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
