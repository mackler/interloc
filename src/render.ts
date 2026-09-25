// Markdown rendering of the records (pure): the round in conversation.md, the decision lines, the question lists,
// and the headings of the subjects (finding 27: the Store writes; it does not compose text).

import type { SubjectId } from "./artifacts.ts";
import type { PlannerResponse, Review } from "./schema.ts";
import type { DecisionEvent } from "./reviewState.ts";

/** A question list as the agents exchange it or as the program records it (a recorded default may be null). */
export type RenderableQuestions = Readonly<{
  questions: readonly Readonly<{ id: string; question: string; reason: string; proposed_answers: readonly Readonly<{ label: string; description: string }>[]; default_answer: string | null }>[];
}>;

/** "Question review", "Requirements review", "Planning phase k": the heading of a subject's rounds. */
export const subjectHeading = (subject: SubjectId): string => (subject === "questions" ? "Question review" : subject === "requirements" ? "Requirements review" : `Planning phase ${subject.plan}`);

export function renderRound(heading: string, round: number, review: Review, response: PlannerResponse): string {
  const issues = review.issues.map((i) => `- **[${i.id}]** (${i.severity}, ${i.location}) ${i.problem}\n  Evidence: ${i.evidence}`);
  const answers = response.dispositions.map((d) => {
    const dup = d.duplicate_of !== "" ? ` (duplicate of ${d.duplicate_of})` : "";
    const rev = d.reverses !== "" ? ` (reverses ${d.reverses})` : "";
    return `- **[${d.id}]** ${d.action}${dup}${rev}: ${d.rationale}`;
  });
  const self = response.self_corrections.map((s) => `- **Self-correction** (${s.new_action}, issue "${s.id}"): ${s.explanation}`);
  const feedback = response.reviewer_feedback !== "" ? [`- **Feedback to the reviewer:** ${response.reviewer_feedback}`] : [];
  return `## ${heading}, round ${round}\n\n### Codex\n\n${issues.join("\n")}\n\n### Claude Code\n\n${[...answers, ...self, ...feedback].join("\n")}\n\n`;
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
