// Markdown rendering of the records (pure): the round in conversation.md, the decision lines, the question lists,
// and the headings of the subjects (finding 27: the Store writes; it does not compose text).

import type { SubjectId } from "./artifacts.ts";
import type { AnalysisView, EntryView } from "./analysisView.ts";
import { CONTEXT_BY_PROGRAM, decisionViewHeading, OPPOSES_MARKER, optionHeading, originLine, questionTitle, recommendedOption, TERMS_HEADING } from "./prompts.ts";
import { type PauseFacts, pauseOriginOf, type PresentedOption, type PresentedQuestion, type QuestionOrigin, type ShownEntry } from "./question.ts";
import * as words from "./prompts.ts";
import type { Disposition, Issue } from "./schema.ts";
import type { PlannerResponse, Review } from "./schema.ts";
import type { DecisionEvent } from "./reviewState.ts";
import type { TurnText } from "./schemaNormalize.ts";
import type { InterviewStage } from "./uiEvents.ts";

/** A question list as the agents exchange it or as the program records it (a recorded default may be null). */
export type RenderableQuestions = Readonly<{
  questions: readonly Readonly<{ id: string; question: string; reason: string; proposed_answers: readonly Readonly<{ label: string; description: string }>[]; default_answer: string | null }>[];
}>;

/** "Question review", "Requirements review", "Planning phase k": the heading of a subject's rounds. */
export const subjectHeading = (subject: SubjectId): string =>
  subject === "questions"
    ? "Question review"
    : subject === "terms"
      ? "Terms review"
      : subject === "requirements"
      ? "Requirements review"
      : "plan" in subject
        ? `Planning phase ${subject.plan}`
        : "work" in subject
          ? `Work review ${subject.work}`
          : `Decision ${subject.decision}`;

export function renderRound(heading: string, round: number, review: Review, response: PlannerResponse): string {
  return `## ${heading}, round ${round}\n\n${renderReview(review)}${renderResponse(response)}`;
}

/** The lines of one decision: for user-decisions.md and for conversation.md. */
export const renderDecision = (event: DecisionEvent): Readonly<{ record: string; conversation: string }> => ({
  record: `Subject: ${event.subject}\nDecision: ${event.decision}\n\n`,
  conversation: `**User decision** on ${event.subject}: ${event.decision}\n\n`,
});

export const renderFeedback = (heading: string, round: number, text: string): string => `## ${heading}, round ${round}\n${text}\n\n`;

export function renderQuestions(list: RenderableQuestions): string {
  if (list.questions.length === 0) return "The list is empty.\n";
  return (
    list.questions
      .map((q) => {
        const answers = q.proposed_answers.map((a) => `  - ${a.label}: ${a.description}${a.label === q.default_answer ? " (default)" : ""}`).join("\n");
        return `- **[${q.id}]** ${q.question}\n  Reason: ${q.reason}\n${answers}`;
      })
      .join("\n") + "\n"
  );
}

/** The explanations of the agreed questions' terms in conversation.md (S17). */
export const renderTerms = (entries: readonly Readonly<{ id: string; terms: readonly Readonly<{ term: string; explanation: string }>[] }>[]): string =>
  entries.map((e) => `- **[${e.id}]** ${e.terms.length === 0 ? "no term" : e.terms.map((t) => `${t.term}: ${t.explanation}`).join("; ")}`).join("\n") + "\n";

/** The terminal lines of an interview turn, in order; the page shows the turn once and absorbs these lines (plan 4.2). */
export const interviewSays = (turn: TurnText): readonly string[] =>
  turn.kind === "summary_proposed" ? [`\n${turn.message}\n`, `Summary proposed by Claude Code:\n\n${turn.summary}\n`] : [`\n${turn.message}\n`];

/** Claude Code's prose as the terminal prints it (issue #5): the prefix is the terminal's only attribution. */
export const claudeLine = (text: string): string => `[claude] ${text}`;

/** Codex's half of a round (the page shows it as Codex's message). */
export const renderReview = (review: Review): string =>
  `### Codex\n\n${review.issues.map((i) => `- **[${i.id}]** (${i.severity}, ${i.location}) ${i.problem}\n  Evidence: ${i.evidence}`).join("\n")}\n\n`;
/** Claude Code's half of a round. */
export const renderResponse = (response: PlannerResponse): string => {
  const answers = response.dispositions.map((d) => {
    const dup = d.duplicate_of !== "" ? ` (duplicate of ${d.duplicate_of})` : "";
    const rev = d.reverses !== "" ? ` (reverses ${d.reverses})` : "";
    return `- **[${d.id}]** ${d.action}${dup}${rev}: ${d.rationale}`;
  });
  const self = response.self_corrections.map((s) => `- **Self-correction** (${s.new_action}, issue "${s.id}"): ${s.explanation}`);
  const feedback = response.reviewer_feedback !== "" ? [`- **Feedback to the reviewer:** ${response.reviewer_feedback}`] : [];
  return `### Claude Code\n\n${[...answers, ...self, ...feedback].join("\n")}\n\n`;
};

/** The heading of an interview in conversation.md, a record: unchanged when the user-facing name changes (issue #21). */
export const recordHeading = (stage: InterviewStage): string => {
  switch (stage) {
    case "clarification":
      return "Interview";
    case "followUp":
      return "Second interview";
    case "conversation":
      return "Conversation before planning";
  }
};

/** A decision's opening in conversation.md: its heading, the question and the options (decision support). */
export const renderDecisionOpened = (k: number, question: string, options: readonly Readonly<{ label: string; description: string }>[]): string =>
  `## Decision ${k}\n\n${question}\n\n${options.map((o, i) => `${i + 1}. ${o.label}${o.description === "" ? "" : ` — ${o.description}`}`).join("\n")}\n\n`;
/** A reference of a decision analysis that named no entry and was dropped (D9). */
export const renderReferenceDropped = (argument: string, named: string): string =>
  `**Reference dropped:** argument ${argument} names ${named}, which is no entry of the analysis; treated as no reference.\n\n`;
/** An option label of an analysis that matched only after normalization, rewritten to the exact label (issue #37, decision Q4). */
export const renderLabelCorrected = (given: string, exact: string): string =>
  `**Option label corrected:** the analysis named ${JSON.stringify(given)}, which the program read as the option ${JSON.stringify(exact)}.\n\n`;
/** A plan whose stage or step numbers were not 1…n in order, renumbered by position (issue #6: the numbers are display only). */
export const renderPlanRenumbered = (): string => "**Plan renumbered:** the stage or step numbers of the plan were not 1, 2, 3 … in order; the program numbered them by position.\n\n";
/** The user's answer after decision k (decision Q4), in conversation.md. */
export const renderChoice = (k: number, answer: string, option: string | null): string =>
  `**User choice** after decision ${k}: ${answer === "" ? "(none)" : answer}${option === null ? "" : ` (${option})`}\n\n`;
/**
 * A decision's analysis as the terminal prints it (decision support): the options one after another, each with the
 * heading "Advantages:", its labeled advantages ("Advantage 1:"), the heading "Disadvantages:" and its labeled
 * disadvantages (issue #35); every element a bullet, each counterargument indented under the element it disputes, two
 * more spaces per level; the equivalence symbols after titles and sentences. A line whose text argues against the
 * option carries OPPOSES_MARKER after its indentation, where the page uses the error color (issue #35, Q9). An unclear
 * option shows what is unclear in place of its headings.
 */
export const analysisLines = (k: number, question: string, view: AnalysisView): readonly string[] => {
  const marked = (text: string, symbol: string | null) => (symbol === null ? text : `${text} ${symbol}`);
  // Every physical line of a text (W1-R1-2): its indentation, the marker where it opposes the option, and the first-line
  // prefix ("- " for an element), whose width indents the continuation lines so that they align under the text.
  const lines = (indent: number, prefix: string, opposes: boolean, text: string): readonly string[] =>
    text.split("\n").map((part, i) => `${" ".repeat(indent)}${opposes ? OPPOSES_MARKER : ""}${i === 0 ? prefix : " ".repeat(prefix.length)}${part}`);
  const entryLines = (entry: EntryView): readonly string[] => [
    ...lines(2, "", entry.opposes, `${entry.label} ${marked(entry.title, entry.symbol)}`),
    ...entry.elements.flatMap((el) => [...lines(4, "- ", el.opposes, el.text), ...el.arguments.flatMap((a) => lines(6 + 2 * a.level, "", a.opposes, marked(a.text, a.symbol)))]),
  ];
  const columns = view.columns.flatMap((column, i) => [
    optionHeading(i + 1, column.option),
    "",
    ...(column.kind === "unclear"
      ? lines(2, "", false, column.unclear)
      : [`  ${column.advantagesHeading}`, ...column.advantages.flatMap((e) => ["", ...entryLines(e)]), "", `  ${column.disadvantagesHeading}`, ...column.disadvantages.flatMap((e) => ["", ...entryLines(e)])]),
    "",
  ]);
  const recommendation = view.recommendation === null ? [] : [recommendedOption(view.recommendation.option), view.recommendation.reason];
  return ["", decisionViewHeading(k, question), "", ...columns, ...recommendation];
};

// ---- the one presentation of a question (S8) --------------------------------------------------------------------------

/** How an option is chosen in the terminal: its exact answer, or a number the user types (the more cycles, S8). */
export const optionLine = (o: PresentedOption): string => {
  const description = o.description === "" ? "" : ` — ${o.description}`;
  return "token" in o.answer ? `  ${o.answer.token}. ${o.label}${description}` : `  ${o.label} (type the number)${description}`;
};
const indented = (text: string, by: string): readonly string[] => text.split("\n").map((line) => (line.trim() === "" ? "" : `${by}${line}`));
/**
 * A question as the terminal prints it (S8), the same shape whatever produced it: the heading with its number and the
 * line saying where it came from; the context paragraph, indented and set apart, marked when the program wrote it; what
 * the question is about (a pause's facts, the summary to confirm; S11); the terms with their explanations (decision Q6); the question itself, not indented, so that it reads apart from the
 * context; and the options, each with the answer that chooses it.
 */
export const questionLines = (q: PresentedQuestion): readonly string[] => [
  "",
  questionTitle(q.number),
  ...indented(originLine(q.origin, q.decision), "  "),
  "",
  ...indented(q.context.by === "program" ? `${q.context.text} (${CONTEXT_BY_PROGRAM})` : q.context.text, "    "),
  ...(q.details.trim() === "" ? [] : ["", ...indented(q.details, "    ")]),
  ...(q.terms.length === 0 ? [] : ["", `    ${TERMS_HEADING}`, ...q.terms.flatMap((t) => indented(`${t.term}: ${t.explanation}`, "      "))]),
  "",
  ...q.question.split("\n"),
  ...(q.options.length === 0 ? [] : ["", ...q.options.map(optionLine)]),
  "",
];

/** The id by which a record names the question (S6): an agreed question's, a follow-up's, an issue's; null for the others. */
export const recordIdOf = (origin: QuestionOrigin): string | null =>
  origin.kind === "clarification" || origin.kind === "followUp" ? origin.id : origin.kind === "pause" && "id" in origin ? origin.id : null;
/** A question in conversation.md (S6): under its displayed number, with the record's id beside it, so that the two can be matched. */
export const renderQuestionRecord = (q: PresentedQuestion): string => {
  const id = recordIdOf(q.origin);
  const terms = q.terms.length === 0 ? "" : `**${TERMS_HEADING}**\n\n${q.terms.map((t) => `- ${t.term}: ${t.explanation}`).join("\n")}\n\n`;
  const options = q.options.length === 0 ? "" : `${q.options.map((o) => `- ${"token" in o.answer ? `${o.answer.token}. ` : ""}${o.label}${o.description === "" ? "" : ` — ${o.description}`}`).join("\n")}\n\n`;
  const context = q.context.text.trim() === "" ? "" : `${q.context.text.split("\n").map((l) => `> ${l}`).join("\n")}${q.context.by === "program" ? ` (${CONTEXT_BY_PROGRAM})` : ""}\n\n`;
  const details = q.details.trim() === "" ? "" : `${q.details.trim()}\n\n`;
  return `### ${questionTitle(q.number)}${id === null ? "" : ` (${id})`}\n\n_${originLine(q.origin, q.decision)}_\n\n${context}${details}${terms}**${q.question}**\n\n${options}`;
};
/** A question as the page shows it in the conversation (S8): the same parts as the terminal's, in Markdown. */
export const questionMarkdown = (q: PresentedQuestion): string => {
  const context = q.context.text.trim() === "" ? "" : `${q.context.text}${q.context.by === "program" ? ` _(${CONTEXT_BY_PROGRAM})_` : ""}\n\n`;
  const terms = q.terms.length === 0 ? "" : `${TERMS_HEADING}\n\n${q.terms.map((t) => `- **${t.term}**: ${t.explanation}`).join("\n")}\n\n`;
  const options = q.options.length === 0 ? "" : `\n\n${q.options.map((o) => `- ${"token" in o.answer ? `${o.answer.token}. ` : ""}**${o.label}**${o.description === "" ? "" : ` — ${o.description}`}`).join("\n")}`;
  const details = q.details.trim() === "" ? "" : `${q.details.trim()}\n\n`;
  return `**${questionTitle(q.number)}** · _${originLine(q.origin, q.decision)}_\n\n${context}${details}${terms}**${q.question}**${options}`;
};

// ---- a pause's facts as prose (S11, issue #19) -------------------------------------------------------------------------

/** One entry of an issue's history in words, without the record's field names or its empty fields. */
const entryProse = (e: ShownEntry): string => {
  switch (e.source) {
    case "review":
      return words.reviewEntryLine(e.round, e.problem, words.dispositionWords(e.action), e.rationale);
    case "self_correction":
      return words.selfCorrectionLine(e.round, words.selfCorrectionWords(e.action), e.rationale);
    case "user":
      return words.userDecisionLine(e.round, e.rationale);
  }
};
const historyProse = (history: readonly ShownEntry[]): readonly string[] => (history.length === 0 ? [] : [words.HISTORY_HEADING, history.map((e) => `- ${entryProse(e)}`).join("\n")]);
const issueProse = (issue: Issue | null): readonly string[] => (issue === null ? [] : [`${words.CODEX_SAYS} ${issue.problem.trim()}`, ...(issue.evidence.trim() === "" ? [] : [issue.evidence.trim()])]);
const answerProse = (d: Disposition | null): readonly string[] => (d === null ? [] : [words.claudeAnswers(words.dispositionWords(d.action), d.rationale)]);
/**
 * A pause of behaviour 7 as the user reads it (S11, issue #19): what happened, what Codex says and what Claude Code
 * answers, and the point's history, in Markdown; the null and empty fields of the records are left out.
 */
export const pauseProse = (facts: PauseFacts): string => {
  const lead = words.pauseLead(pauseOriginOf(facts));
  const parts = ((): readonly string[] => {
    switch (facts.pause) {
      case "reraised":
        return [...issueProse(facts.issue), ...historyProse(facts.history)];
      case "secondClarification":
        return [...answerProse(facts.disposition), ...historyProse(facts.history)];
      case "disputedSelfCorrection":
        return [facts.explanation.trim(), ...historyProse(facts.history)];
      case "reversal":
        return [...issueProse(facts.issue), ...answerProse(facts.disposition), ...historyProse(facts.history)];
      case "repeatedUnderNewId":
        return [...issueProse(facts.issue), ...historyProse(facts.history)];
      case "unexplained":
        return [words.claudeResponseText(facts.resultText)];
      case "identical":
        return [words.identicalFacts(facts.fileLabel, facts.round, facts.seen)];
      case "idle":
        return facts.issues.length === 0 ? [] : [words.IDLE_ISSUES_HEADING, facts.issues.map((e) => `- ${entryProse(e)}`).join("\n")];
    }
  })();
  return [lead, ...parts.filter((p) => p !== "")].join("\n\n");
};
