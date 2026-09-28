// Markdown rendering of the records (pure): the round in conversation.md, the decision lines, the question lists,
// and the headings of the subjects (finding 27: the Store writes; it does not compose text).

import type { SubjectId } from "./artifacts.ts";
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

/** The terminal lines of an interview turn, in order; the page shows the turn once and absorbs these lines (plan 4.2). */
export const interviewSays = (turn: TurnText): readonly string[] =>
  turn.kind === "summary_proposed" ? [`\n${turn.message}\n`, `Summary proposed by Claude Code:\n\n${turn.summary}\n`] : [`\n${turn.message}\n`];

/** A question Claude Code relays to the user, with its options. */
export type RelayedQuestion = Readonly<{ question: string; options: readonly Readonly<{ label: string; description: string }>[] }>;
/** The terminal lines of a relayed question, in order; the page shows the question once and absorbs these lines (issue #7). */
export const relayedQuestionSays = (q: RelayedQuestion): readonly string[] => [`\nQuestion from Claude Code: ${q.question}`, ...q.options.map((o, i) => `  ${i + 1}. ${o.label} - ${o.description}`)];
/** A relayed question as the page shows it: Markdown, as Claude's message (issue #7). */
export const relayedQuestionMarkdown = (q: RelayedQuestion): string =>
  q.options.length === 0 ? q.question : `${q.question}\n\n${q.options.map((o, i) => `${i + 1}. **${o.label}**${o.description === "" ? "" : ` — ${o.description}`}`).join("\n")}`;

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
/** The user's answer after decision k (decision Q4), in conversation.md. */
export const renderChoice = (k: number, answer: string, option: string | null): string =>
  `**User choice** after decision ${k}: ${answer === "" ? "(none)" : answer}${option === null ? "" : ` (${option})`}\n\n`;
/** The terminal lines of options presented with a question: one per option, numbered from 1. */
export const optionLines = (options: readonly Readonly<{ label: string; description: string }>[]): readonly string[] =>
  options.map((o, i) => `  ${i + 1}. ${o.label}${o.description === "" ? "" : ` - ${o.description}`}`);
