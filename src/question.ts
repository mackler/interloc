// A question put to the user (S2 and following): its parts, and the mechanical part of the rules of QUESTION_RULES in
// src/prompts.ts. Pure; also imported by the browser (the occurrence of a term, which the page marks as validated here).
import { Result } from "effect";
import { QuestionInvalid } from "./errors.ts";
import type { QuestionProblem } from "./prompts.ts";

/** A word or phrase the reader may not know, bound to its exact words in the text, with its explanation (issue #36, Q5). */
export type Term = Readonly<{ term: string; explanation: string }>;
export type QuestionOption = Readonly<{ label: string; description: string }>;
/** The parts of a question that an agent writes: the context paragraph, the question, its terms and its options. */
export type Question = Readonly<{ context: string; question: string; terms: readonly Term[]; options: readonly QuestionOption[] }>;

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
const textsOf = (q: Question): readonly string[] => [q.context, q.question, ...q.options.flatMap((o) => [o.label, o.description])];

/** The problems of one question; none when it keeps every mechanically checkable rule. */
export const questionProblems = (q: Question): readonly QuestionProblem[] => {
  const texts = textsOf(q);
  const names = q.terms.map((t) => t.term);
  return [
    ...(q.context.trim() === "" ? [{ kind: "blankContext" as const, subject: "" }] : []),
    ...(/\?["'”’)\]]*$/u.test(q.question.trim()) ? [] : [{ kind: "notLast" as const, subject: "" }]),
    ...q.terms.flatMap((t, i): QuestionProblem[] => {
      if (t.term.trim() === "") return [{ kind: "blankTerm", subject: "" }];
      return [
        ...(t.explanation.trim() === "" ? [{ kind: "blankExplanation" as const, subject: t.term }] : []),
        ...(texts.some((text) => termOccurrences(text, t.term).length > 0) ? [] : [{ kind: "termAbsent" as const, subject: t.term }]),
        ...(names.indexOf(t.term) < i ? [{ kind: "duplicateTerm" as const, subject: t.term }] : []),
      ];
    }),
    ...texts.flatMap(bareNumbers).map((subject) => ({ kind: "bareNumber" as const, subject })),
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
