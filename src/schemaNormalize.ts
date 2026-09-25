// Normalisation of agent replies after decoding (finding 8 of docs/functional-design-review.md; decision Q4):
// the wire shapes with coexisting fields become variants. Pure.

import { Result } from "effect";
import { QuestionListInvalid } from "./errors.ts";
import type { ExecReport, InterviewTurn, QuestionList, QuestionsFile } from "./schema.ts";

/** One interview turn: the conversation continues, or Claude Code proposes the summary. */
export type TurnVariant = Readonly<{ kind: "continuing"; message: string }> | Readonly<{ kind: "summary_proposed"; message: string; summary: string }>;
/** `complete` with a blank summary, and a summary without `complete`, both continue the conversation (Q4: no coverage check). */
export const normalizeTurn = (turn: InterviewTurn): TurnVariant =>
  turn.complete && turn.summary.trim() !== "" ? { kind: "summary_proposed", message: turn.message_to_user, summary: turn.summary } : { kind: "continuing", message: turn.message_to_user };

/** The status report of an execution call, by outcome: the `question` field is a question only when input is awaited, a description when blocked. */
export type ReportVariant =
  | Readonly<{ kind: "finished"; summary: string; remainingWork: string }>
  | Readonly<{ kind: "awaiting_input"; question: string; summary: string; remainingWork: string }>
  | Readonly<{ kind: "blocked"; description: string; summary: string; remainingWork: string }>;
export const normalizeReport = (report: ExecReport): ReportVariant => {
  const common = { summary: report.summary, remainingWork: report.remaining_work };
  switch (report.status) {
    case "finished":
      return { kind: "finished", ...common };
    case "needs_input":
      return { kind: "awaiting_input", question: report.question, ...common };
    case "blocked":
      return { kind: "blocked", description: report.question, ...common };
  }
};

/** A question list as the program records it: a default that names no proposed answer is null, with a note per question. */
export type NormalizedQuestionList = Readonly<{ questions: QuestionsFile["questions"]; notes: readonly string[] }>;
/** Duplicate or empty ids are structural (by analogy with Q3): the list is invalid, without a repair turn. */
export const normalizeQuestionList = (list: QuestionList): Result.Result<NormalizedQuestionList, QuestionListInvalid> => {
  const ids = list.questions.map((q) => q.id);
  const duplicateIds = [...new Set(ids.filter((id, i) => id !== "" && ids.indexOf(id) !== i))];
  const emptyIds = ids.filter((id) => id === "").length;
  if (duplicateIds.length > 0 || emptyIds > 0) return Result.fail(new QuestionListInvalid({ duplicateIds, emptyIds }));
  const notes: string[] = [];
  const questions = list.questions.map((q) => {
    if (q.proposed_answers.some((a) => a.label === q.default_answer)) return { ...q, id: q.id, default_answer: q.default_answer as string | null };
    notes.push(`The default answer of question ${q.id}, ${JSON.stringify(q.default_answer)}, names none of its proposed answers; the question has no default.`);
    return { ...q, id: q.id, default_answer: null };
  });
  return Result.succeed({ questions, notes });
};
