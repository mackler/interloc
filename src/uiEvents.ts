// The structured events of a run for a user interface (decision Q5): the terminal ignores them but InterviewOpened and ClaudeSaid, the scripted Ui
// records them, the web Ui turns them into the page's panels, activity line and progress. Pure; types only from src/.

import { type SubjectId, subjectDir } from "./artifacts.ts";
import { cycleHeading, phaseLabel } from "./prompts.ts";
import type { DecisionAnalysis, DecisionResponse, ExecOutcome, PlannerResponse, QuestionListResponse, Review, UserQuestion } from "./schema.ts";

/** A phase of the run as the progress display names it. */
export type Phase = Readonly<{ kind: "questions" }> | Readonly<{ kind: "planning" | "execution" | "work"; n: number }>;
/** Which conversation with the user runs (issue #21): the first clarification, a follow-up on accepted requirements gaps, or the conversation after an empty agreed list. */
export type InterviewStage = "clarification" | "followUp" | "conversation";
export type Agent = "claude" | "codex";
export type LoopResult = "converged" | "proceed" | "revise";

export type UiEvent =
  | Readonly<{ _tag: "PhaseBegan"; phase: Phase }>
  | Readonly<{ _tag: "PhaseEnded"; phase: Phase; result: string }>
  | Readonly<{ _tag: "RoundBegan"; subject: SubjectId; round: number; limit: number }>
  | Readonly<{ _tag: "ReviewReceived"; subject: SubjectId; round: number; review: Review; counted: number }>
  /** The question subject answers with its amended list besides (defect A of docs/page-question-phase-defects.md), a decision with its amended analysis (W2-R1-1). */
  | Readonly<{ _tag: "ResponseReceived"; subject: SubjectId; round: number; response: PlannerResponse | QuestionListResponse | DecisionResponse; resultText: string }>
  | Readonly<{ _tag: "LoopFinished"; subject: SubjectId; result: LoopResult }>
  | Readonly<{ _tag: "PlanWritten"; phase: number; questions: readonly UserQuestion[]; resultText: string }>
  | Readonly<{ _tag: "ExecutionEnded"; phase: number; outcome: ExecOutcome }>
  | Readonly<{ _tag: "AgentCallStarted"; agent: Agent; purpose: string }>
  | Readonly<{ _tag: "ToolUsed"; agent: Agent; tool: string; target: string }>
  | Readonly<{ _tag: "AgentCallEnded"; agent: Agent; ok: boolean }>
  | Readonly<{ _tag: "QuestionAsked"; question: string; options: readonly Readonly<{ label: string; description: string }>[] }>
  /** `answered` of `total` questions so far (issue #21): the agreed ones and the follow-ups Claude reports asking. */
  | Readonly<{ _tag: "InterviewTurn"; heading: string; message: string; summary: string | null; answered: number; total: number }>
  /** The interview begins; each interface renders its own help (finding 8 of docs/gui-review.md). */
  | Readonly<{ _tag: "InterviewOpened"; heading: string; stage: InterviewStage; total: number }>
  /** Claude Code's prose during an execution call, attributed as data (issue #5); the terminal prefixes it with "[claude] ". */
  | Readonly<{ _tag: "ClaudeSaid"; text: string }>
  /** The options of the next prompt (a pause, a plan writer's question): the page shows them as cards (decision support). */
  | Readonly<{ _tag: "OptionsPresented"; question: string; options: readonly Readonly<{ label: string; description: string }>[] }>
  /** A decision loop has ended: its analysis, shown before the question is asked again (decision support). */
  | Readonly<{ _tag: "DecisionAnalyzed"; decision: number; question: string; options: readonly Readonly<{ label: string; description: string }>[]; analysis: DecisionAnalysis }>
  /** The last answer was rejected (a blank reply where one is required) and the question is asked again (W3-R1-1); for the page. */
  | Readonly<{ _tag: "AnswerRejected" }>;

const AGENT_LABEL: Record<Agent, string> = { claude: "Claude Code", codex: "Codex" };
/** The name of a phase as the progress display shows it. */
export const phaseName = (phase: Phase): string => (phase.kind === "questions" ? phaseLabel("questions", 0) : phaseLabel(phase.kind, phase.n));
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One line per event, for test output. Total over the variants. */
export const describeEvent = (event: UiEvent): string => {
  switch (event._tag) {
    case "PhaseBegan":
      return `${phaseName(event.phase)} began`;
    case "PhaseEnded":
      return `${phaseName(event.phase)} ended: ${event.result}`;
    case "RoundBegan":
      return cycleHeading(subjectDir(event.subject), event.round);
    case "ReviewReceived":
      return `review of ${subjectDir(event.subject)}, round ${event.round}: ${plural(event.review.issues.length, "issue")}, ${event.counted} counted`;
    case "ResponseReceived":
      return `response in ${subjectDir(event.subject)}, round ${event.round}`;
    case "LoopFinished":
      return `${subjectDir(event.subject)} finished: ${event.result}`;
    case "PlanWritten":
      return `plan written in phase ${event.phase}, ${plural(event.questions.length, "question")}`;
    case "ExecutionEnded":
      return `execution ${event.phase} ended: ${event.outcome.status}`;
    case "AgentCallStarted":
      return `${AGENT_LABEL[event.agent]} call started: ${event.purpose}`;
    case "ToolUsed":
      return `${AGENT_LABEL[event.agent]} used ${event.tool} ${event.target}`.trimEnd();
    case "AgentCallEnded":
      return `${AGENT_LABEL[event.agent]} call ended: ${event.ok ? "ok" : "failed"}`;
    case "QuestionAsked":
      return `question: ${event.question} (${plural(event.options.length, "option")})`;
    case "InterviewTurn":
      return `${event.heading} (${event.answered} of ${event.total} answered): ${event.message}`;
    case "InterviewOpened":
      return `${event.heading} opened, ${plural(event.total, "question")}`;
    case "ClaudeSaid":
      return `Claude Code said: ${event.text}`;
    case "OptionsPresented":
      return `options: ${event.question} (${plural(event.options.length, "option")})`;
    case "DecisionAnalyzed":
      return `decision ${event.decision} analyzed: ${event.question} (${plural(event.analysis.columns.length, "column")})`;
    case "AnswerRejected":
      return "answer rejected, asked again";
  }
};
