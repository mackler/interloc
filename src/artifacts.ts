// The catalog of the program's records under <project>/plan-review/ (finding 28 of
// docs/functional-design-review.md): typed identities and one `pathOf`, so that no workflow builds a path. Pure.

/** A reviewed subject: the question list, the requirements, the plan of one planning phase, or the work of one execution phase (the work review). */
export type SubjectId = "questions" | "requirements" | Readonly<{ plan: number }> | Readonly<{ work: number }>;

export type Artifact =
  | Readonly<{ kind: "conversation" | "decisions" | "feedback" | "usage" | "questions" | "requirements" | "plan" | "checkpoint" | "config" }>
  | Readonly<{ kind: "log"; subject: SubjectId }>
  | Readonly<{ kind: "review" | "response" | "round"; subject: SubjectId; round: number }>
  | Readonly<{ kind: "planWrite" | "execution"; phase: number }>
  /** The tree of the project at the start of the run (Q7), and the change record a work review reads. */
  | Readonly<{ kind: "baseline" }>
  | Readonly<{ kind: "changes"; phase: number }>
  | Readonly<{ kind: "invalidReply"; agent: "claude" | "codex"; n: number }>;

/** The directory of the records, relative to the project. */
export const RECORDS_DIR = "plan-review";

/** The phase recorded in a subject's log entries: 0 for the question list and the requirements. */
export const phaseOf = (subject: SubjectId): number => (typeof subject !== "object" ? 0 : "plan" in subject ? subject.plan : subject.work);
/** The subdirectory of plan-review/ that holds a subject's round files. */
export const subjectDir = (subject: SubjectId): string =>
  subject === "questions" ? "question-review" : subject === "requirements" ? "requirements-review" : "plan" in subject ? `planning-${subject.plan}` : `work-review-${subject.work}`;
const PLANNING_DIR = /^planning-([1-9][0-9]*)$/;
const WORK_DIR = /^work-review-([1-9][0-9]*)$/;
/** The subject of a subdirectory name, or null for a name that is not one. */
export const subjectOf = (dirName: string): SubjectId | null => {
  if (dirName === "question-review") return "questions";
  if (dirName === "requirements-review") return "requirements";
  const planning = PLANNING_DIR.exec(dirName);
  if (planning !== null) return { plan: Number(planning[1]) };
  const work = WORK_DIR.exec(dirName);
  return work === null ? null : { work: Number(work[1]) };
};
/** The file a subject's review reads. */
export const reviewedFile = (subject: SubjectId): Artifact =>
  subject === "questions" || subject === "requirements" ? { kind: subject } : "plan" in subject ? { kind: "plan" } : { kind: "changes", phase: subject.work };
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
      return artifact.subject === "questions" ? "questions-log.json" : artifact.subject === "requirements" ? "requirements-log.json" : "plan" in artifact.subject ? "issue-log.json" : "work-review-log.json";
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
    default:
      return FIXED[artifact.kind];
  }
};
/** The path as messages and prompts name it: `plan-review/<path>`. */
export const recordPath = (artifact: Artifact): string => `${RECORDS_DIR}/${pathOf(artifact)}`;
/** The four issue logs (one subject of each). */
export const LOG_SUBJECTS: readonly SubjectId[] = [{ plan: 1 }, "questions", "requirements", { work: 1 }];
