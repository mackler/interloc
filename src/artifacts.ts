// The catalog of the program's records under <project>/plan-review/ (finding 28 of
// docs/functional-design-review.md): typed identities and one `pathOf`, so that no workflow builds a path. Pure.

/**
 * A reviewed subject: the question list, the requirements, the plan of one planning phase, the work of one execution
 * phase (the work review), or the analysis of decision k (decision support, numbered across the run).
 */
export type SubjectId = "questions" | "requirements" | Readonly<{ plan: number }> | Readonly<{ work: number }> | Readonly<{ decision: number }>;
/** A subject whose phase follows from its identity; a decision's phase is where it took place, which its identity does not say. */
export type PhasedSubject = Exclude<SubjectId, Readonly<{ decision: number }>>;

export type Artifact =
  | Readonly<{ kind: "conversation" | "decisions" | "feedback" | "usage" | "questions" | "requirements" | "plan" | "checkpoint" | "config" }>
  | Readonly<{ kind: "log"; subject: SubjectId }>
  | Readonly<{ kind: "review" | "response" | "round"; subject: SubjectId; round: number }>
  | Readonly<{ kind: "planWrite" | "execution"; phase: number }>
  /** The tree of the project at the start of the run (Q7), and the change record a work review reads. */
  | Readonly<{ kind: "baseline" }>
  | Readonly<{ kind: "changes"; phase: number }>
  | Readonly<{ kind: "invalidReply"; agent: "claude" | "codex"; n: number }>
  /** Decision k: the question and its options, the reviewed analysis, the analysis call's raw output, the user's choice. */
  | Readonly<{ kind: "decisionQuestion" | "analysis" | "analysisWrite" | "chosen"; decision: number }>;

/** The directory of the records, relative to the project. */
export const RECORDS_DIR = "plan-review";

/** The phase recorded in a subject's log entries: 0 for the question list and the requirements. */
export const phaseOf = (subject: PhasedSubject): number => (typeof subject !== "object" ? 0 : "plan" in subject ? subject.plan : subject.work);
/** The subdirectory of plan-review/ that holds a subject's round files. */
export const subjectDir = (subject: SubjectId): string =>
  subject === "questions"
    ? "question-review"
    : subject === "requirements"
      ? "requirements-review"
      : "plan" in subject
        ? `planning-${subject.plan}`
        : "work" in subject
          ? `work-review-${subject.work}`
          : `decision-${subject.decision}`;
const PLANNING_DIR = /^planning-([1-9][0-9]*)$/;
const WORK_DIR = /^work-review-([1-9][0-9]*)$/;
const DECISION_DIR = /^decision-([1-9][0-9]*)$/;
/** The subject of a subdirectory name, or null for a name that is not one. */
export const subjectOf = (dirName: string): SubjectId | null => {
  if (dirName === "question-review") return "questions";
  if (dirName === "requirements-review") return "requirements";
  const planning = PLANNING_DIR.exec(dirName);
  if (planning !== null) return { plan: Number(planning[1]) };
  const work = WORK_DIR.exec(dirName);
  if (work !== null) return { work: Number(work[1]) };
  const decision = DECISION_DIR.exec(dirName);
  return decision === null ? null : { decision: Number(decision[1]) };
};
/** The file a subject's review reads. */
export const reviewedFile = (subject: SubjectId): Artifact =>
  subject === "questions" || subject === "requirements"
    ? { kind: subject }
    : "plan" in subject
      ? { kind: "plan" }
      : "work" in subject
        ? { kind: "changes", phase: subject.work }
        : { kind: "analysis", decision: subject.decision };
const FIXED: Record<Extract<Artifact, { kind: string }>["kind"] & ("conversation" | "decisions" | "feedback" | "usage" | "questions" | "requirements" | "plan" | "checkpoint" | "config"), string> = {
  conversation: "conversation.md",
  decisions: "user-decisions.md",
  feedback: "reviewer-feedback.md",
  usage: "usage.jsonl",
  questions: "questions.json",
  requirements: "requirements.md",
  plan: "plan.md",
  checkpoint: "checkpoint.json",
  config: "config.json",
};
const ROUND_FILE = { review: "review", response: "cc", round: "round" } as const;
/** The path of an artifact relative to plan-review/, with "/" separators. */
export const pathOf = (artifact: Artifact): string => {
  switch (artifact.kind) {
    case "log":
      return artifact.subject === "questions"
        ? "questions-log.json"
        : artifact.subject === "requirements"
          ? "requirements-log.json"
          : "plan" in artifact.subject
            ? "issue-log.json"
            : "work" in artifact.subject
              ? "work-review-log.json"
              : "decision-log.json";
    case "review":
    case "response":
    case "round":
      return `${subjectDir(artifact.subject)}/${ROUND_FILE[artifact.kind]}-${artifact.round}.json`;
    case "planWrite":
      return `planning-${artifact.phase}/cc-0.json`;
    case "execution":
      return `execution-${artifact.phase}/result.json`;
    case "baseline":
      return "baseline.json";
    case "changes":
      return `work-review-${artifact.phase}/changes.diff`;
    case "invalidReply":
      return `invalid-replies/${artifact.agent}-${artifact.n}.json`;
    case "decisionQuestion":
      return `decision-${artifact.decision}/question.json`;
    case "analysis":
      return `decision-${artifact.decision}/analysis.json`;
    case "analysisWrite":
      return `decision-${artifact.decision}/cc-0.json`;
    case "chosen":
      return `decision-${artifact.decision}/chosen.json`;
    default:
      return FIXED[artifact.kind];
  }
};
/** The path as messages and prompts name it: `plan-review/<path>`. */
export const recordPath = (artifact: Artifact): string => `${RECORDS_DIR}/${pathOf(artifact)}`;
/** The five issue logs (one subject of each). */
export const LOG_SUBJECTS: readonly SubjectId[] = [{ plan: 1 }, "questions", "requirements", { work: 1 }, { decision: 1 }];

/**
 * Whether a path under plan-review/ is a record that a read-only call must leave unchanged (finding 1 of
 * docs/gui-review.md). Exempt: what the program itself writes during a call (usage.jsonl; invalid-replies/, written
 * before a repair turn) and the archives of earlier runs. Every other path is guarded, a kind added later included.
 */
export const guardedRecord = (relPath: string): boolean =>
  relPath !== pathOf({ kind: "usage" }) && relPath !== "invalid-replies" && !relPath.startsWith("invalid-replies/") && !/^archive-[^/]+(\/|$)/.test(relPath);
