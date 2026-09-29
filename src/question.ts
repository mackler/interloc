// A question put to the user (S2 and following): its parts, and the mechanical part of the rules of QUESTION_RULES in
// src/prompts.ts. Pure; also imported by the browser (the occurrence of a term, which the page marks as validated here).
import { Result } from "effect";
import { QuestionInvalid } from "./errors.ts";
import type { QuestionProblem } from "./prompts.ts";
import type { Disposition, Issue, LogEntry, QuestionOption, Term } from "./schema.ts";

export type { QuestionOption, Term };

/**
 * The parts of a question that an agent writes: the context paragraph, the question, its terms and its options; `details`,
 * what the question is about as the program records it (S11), is text a term may occur in too.
 */
export type Question = Readonly<{ context: string; question: string; terms: readonly Term[]; options: readonly QuestionOption[]; details?: string }>;

const WORD = /[\p{L}\p{N}_]/u;
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The start of every case-sensitive, whole-word occurrence of `term` in `text` (issue #36, Q5). */
export const termOccurrences = (text: string, term: string): readonly number[] =>
  term === ""
    ? []
    : [...text.matchAll(new RegExp(escape(term), "gu"))]
        .map((m) => m.index)
        .filter((i) => !WORD.test(text.slice(i - 1, i)) && !WORD.test(text.slice(i + term.length, i + term.length + 1)));

/** Words that stand before a number without saying what it numbers ("see #53", "the #6"). */
const NOT_A_KIND = new Set(["a", "an", "the", "and", "or", "of", "in", "on", "at", "to", "by", "for", "from", "with", "as", "see", "per", "via"]);
/** A reference like "#53" without the kind of thing it numbers before it; "Issues #6, #33 and #28" names its kind once. */
const bareNumbers = (text: string): readonly string[] =>
  [...text.matchAll(/#\d+/gu)].flatMap((m) => {
    const before = text.slice(0, m.index).replace(/(?:#\d+\s*(?:,\s*(?:and\s+|or\s+)?|and\s+|or\s+))+$/u, "");
    const kind = /(\p{L}+)\s+$/u.exec(before);
    return kind !== null && !NOT_A_KIND.has(kind[1].toLowerCase()) ? [] : [m[0]];
  });

/** Every text of a question that its terms may occur in and that is shown to the reader. */
const textsOf = (q: Question): readonly string[] => [q.context, q.question, ...q.options.flatMap((o) => [o.label, o.description]), q.details ?? ""];

/**
 * The problems of one question; none when it keeps every mechanically checkable rule. `scope` "context" checks only what
 * a context call writes (S9): the context and the terms; the program's own question and options are not its to change.
 */
export const questionProblems = (q: Question, scope: "all" | "context" = "all"): readonly QuestionProblem[] => {
  const texts = textsOf(q);
  const names = q.terms.map((t) => t.term);
  return [
    ...(q.context.trim() === "" ? [{ kind: "blankContext" as const, subject: "" }] : []),
    ...(scope === "context" || /\?["'”’)\]]*$/u.test(q.question.trim()) ? [] : [{ kind: "notLast" as const, subject: "" }]),
    ...q.terms.flatMap((t, i): QuestionProblem[] => {
      if (t.term.trim() === "") return [{ kind: "blankTerm", subject: "" }];
      return [
        ...(t.explanation.trim() === "" ? [{ kind: "blankExplanation" as const, subject: t.term }] : []),
        ...(texts.some((text) => termOccurrences(text, t.term).length > 0) ? [] : [{ kind: "termAbsent" as const, subject: t.term }]),
        ...(names.indexOf(t.term) < i ? [{ kind: "duplicateTerm" as const, subject: t.term }] : []),
      ];
    }),
    ...(scope === "context" ? [q.context] : texts).flatMap(bareNumbers).map((subject) => ({ kind: "bareNumber" as const, subject })),
  ];
};

/** Validates one question; `where` names it in the error ("questions_for_user 1", "Q3"). */
export const validateQuestion = (q: Question, where = "the question"): Result.Result<Question, QuestionInvalid> => {
  const problems = questionProblems(q);
  return problems.length === 0 ? Result.succeed(q) : Result.fail(new QuestionInvalid({ questions: [{ where, problems }] }));
};

/** Validates the questions of one reply together: every failing question is named in the one error. */
export const validateQuestions = (questions: readonly Readonly<{ where: string; question: Question }>[]): Result.Result<void, QuestionInvalid> => {
  const failing = questions.map(({ where, question }) => ({ where, problems: questionProblems(question) })).filter((q) => q.problems.length > 0);
  return failing.length === 0 ? Result.succeed(undefined) : Result.fail(new QuestionInvalid({ questions: failing }));
};

// ---- the one presentation of a question (S5, issues #46 and #57) ------------------------------------------------------

/** The pause of behaviour 7 that asks the question, with the ids and names it concerns (S5, S11). */
export type PauseOrigin =
  | Readonly<{ pause: "reraised"; id: string }>
  | Readonly<{ pause: "secondClarification"; id: string }>
  | Readonly<{ pause: "disputedSelfCorrection"; id: string }>
  | Readonly<{ pause: "reversal"; id: string; reverses: string }>
  | Readonly<{ pause: "repeatedUnderNewId"; id: string; repeats: string }>
  | Readonly<{ pause: "unexplained"; fileLabel: string; heading: string; round: number }>
  | Readonly<{ pause: "identical"; fileLabel: string }>
  | Readonly<{ pause: "idle"; idle: number }>;

/** A log entry of a pause's facts; its prose never shows the program's measurement (issue #31). */
export type ShownEntry = LogEntry;
/**
 * What a pause of behaviour 7 is about, as data (S11, issue #19): the ids of its origin, and the review issue, the
 * disposition and the earlier log entries that the user reads as prose (`pauseProse` in src/render.ts), never as JSON.
 */
export type PauseFacts =
  | Readonly<{ pause: "reraised"; id: string; history: readonly ShownEntry[]; issue: Issue | null }>
  | Readonly<{ pause: "secondClarification"; id: string; history: readonly ShownEntry[]; disposition: Disposition | null }>
  | Readonly<{ pause: "disputedSelfCorrection"; id: string; explanation: string; history: readonly ShownEntry[] }>
  | Readonly<{ pause: "reversal"; id: string; reverses: string; history: readonly ShownEntry[]; issue: Issue | null; disposition: Disposition | null }>
  | Readonly<{ pause: "repeatedUnderNewId"; id: string; repeats: string; history: readonly ShownEntry[]; issue: Issue | null }>
  | Readonly<{ pause: "unexplained"; fileLabel: string; heading: string; round: number; resultText: string }>
  | Readonly<{ pause: "identical"; fileLabel: string; round: number; seen: string }>
  | Readonly<{ pause: "idle"; idle: number; round: number; issues: readonly ShownEntry[] }>;
/** The ids a pause's origin keeps of its facts. */
export const pauseOriginOf = (facts: PauseFacts): PauseOrigin => {
  switch (facts.pause) {
    case "reraised":
    case "secondClarification":
    case "disputedSelfCorrection":
      return { pause: facts.pause, id: facts.id };
    case "reversal":
      return { pause: "reversal", id: facts.id, reverses: facts.reverses };
    case "repeatedUnderNewId":
      return { pause: "repeatedUnderNewId", id: facts.id, repeats: facts.repeats };
    case "unexplained":
      return { pause: "unexplained", fileLabel: facts.fileLabel, heading: facts.heading, round: facts.round };
    case "identical":
      return { pause: "identical", fileLabel: facts.fileLabel };
    case "idle":
      return { pause: "idle", idle: facts.idle };
  }
};

/**
 * What produced a question (S5): where it arose in the run, with what the record and the origin line need to name it.
 * A question inside decision k carries k in `PresentedQuestion.decision`, whatever its origin (issue #57).
 */
export type QuestionOrigin =
  /** An agreed question of the clarification, or a question asked there that is not in the list (a follow-up, an accepted requirements issue). */
  | Readonly<{ kind: "clarification"; id: string }>
  | Readonly<{ kind: "followUp"; id: string }>
  /** A turn of the clarification that asks no particular question: the user replies to Claude Code's message. */
  | Readonly<{ kind: "reply" }>
  /** The choice after an empty agreed list: start planning, or talk first. */
  | Readonly<{ kind: "startOrTalk" }>
  /** The confirmation of the summary of a clarification. */
  | Readonly<{ kind: "confirmSummary" }>
  /** A question Claude Code returns with a plan it writes or revises, or with a response to a review (`heading` names where). */
  | Readonly<{ kind: "planner"; heading: string }>
  /** A question Claude Code asks while implementing the plan. */
  | Readonly<{ kind: "relayed" }>
  /** An implementation that stopped without a question the user was asked. */
  | Readonly<{ kind: "execStop"; phase: number; status: string }>
  /** A permission request of Claude Code while implementing the plan. */
  | Readonly<{ kind: "permission"; tool: string; input: string }>
  | (Readonly<{ kind: "pause"; heading: string }> & PauseOrigin)
  | Readonly<{ kind: "limit"; heading: string; limit: number }>
  | Readonly<{ kind: "unchanged"; heading: string; fileLabel: string; accepted: readonly string[] }>
  | Readonly<{ kind: "transport"; agent: "claude" | "codex"; what: string; attempts: number; fault: string }>;

/** The exact text that chooses an option, or any whole number the user types (the more cycles at the cycle limit, S8). */
export type OptionAnswer = Readonly<{ token: string }> | Readonly<{ numeric: true }>;
export type PresentedOption = Readonly<{ label: string; description: string; answer: OptionAnswer }>;
/** Who wrote the context paragraph: an agent, or the program (a fixed paragraph, S7 and S10). */
export type QuestionContextText = Readonly<{ text: string; by: "agent" | "program" }>;
/** What the context call gives a question (S9): its context paragraph, by whom, and the explanations of its terms. */
export type ContextWritten = Readonly<{ context: QuestionContextText; terms: readonly Term[] }>;

/**
 * A question as the user is shown it (S5), the same shape whatever produced it: its number in the run, where it came
 * from, the context paragraph, the terms and their explanations, the question and the options that answer it, and the
 * decision it belongs to (issue #57), or null.
 */
export type PresentedQuestion = Readonly<{
  number: number;
  origin: QuestionOrigin;
  context: QuestionContextText;
  terms: readonly Term[];
  question: string;
  options: readonly PresentedOption[];
  /** What the question is about, in Markdown, shown with the context (S11): a pause's facts, the summary to confirm; "" when none. */
  details: string;
  decision: number | null;
}>;
