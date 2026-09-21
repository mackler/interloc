// Data exchanged between the orchestrator, Claude Code (the planner), and Codex (the reviewer).

export type Severity = "blocking" | "major" | "minor";

export type Issue = {
  id: string;
  severity: Severity;
  plan_section: string;
  problem: string;
  evidence: string;
};

export type Review = { issues: Issue[] };

export type Action =
  | "accepted"
  | "partially_accepted"
  | "rejected"
  | "no_change_needed"
  | "clarification_requested";

export type Disposition = {
  id: string;
  action: Action;
  rationale: string;
  duplicate_of: string;
  reverses: string;
};

export type SelfCorrection = {
  id: string;
  new_action: "accepted" | "rejected" | "plan_error";
  explanation: string;
};

export type PlannerResponse = {
  dispositions: Disposition[];
  self_corrections: SelfCorrection[];
  reviewer_feedback: string;
  questions_for_user: string[];
};

export type PlanWriteResult = { questions_for_user: string[] };

export type ExecReport = {
  status: "finished" | "needs_input" | "blocked";
  summary: string;
  question: string;
  remaining_work: string;
};

export type ExecOutcome = {
  status: "finished" | "needs_input" | "blocked" | "aborted";
  summary: string;
  question: string;
  remainingWork: string;
  // Set when the user's input was already read during the phase (a question from Claude Code).
  userInput: string | null;
};

export type LogEntry = {
  id: string;
  phase: number;
  round: number;
  source: "review" | "self_correction" | "user";
  severity?: Severity;
  plan_section?: string;
  problem: string;
  evidence?: string;
  action: string;
  rationale: string;
  duplicate_of?: string;
  reverses?: string;
  superseded?: boolean;
};

export type Config = {
  maxRounds: number;
  maxIdleRounds: number;
  countMinor: boolean;
  execPermissionMode: "auto" | "acceptEdits" | "bypassPermissions" | "default";
  claudeModel: string | null;
  codexModel: string | null;
};

export const defaultConfig: Config = {
  maxRounds: 5,
  maxIdleRounds: 2,
  countMinor: true,
  execPermissionMode: "auto",
  claudeModel: null,
  codexModel: null,
};
