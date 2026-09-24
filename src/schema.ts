// One definition per kind of data exchanged with the agents or kept on disk: it gives the type
// (`typeof X.Type`), the JSON Schema for the agents (src/jsonSchema.ts) and runtime validation.
// Replaces src/types.ts and src/schemas.ts. API names: docs/effect-v4-api.md.

import { Schema, SchemaIssue, Struct } from "effect";

export const Severity = Schema.Literals(["blocking", "major", "minor"]);

export const Issue = Schema.Struct({
  id: Schema.String,
  severity: Severity,
  location: Schema.String,
  problem: Schema.String,
  evidence: Schema.String,
});

export const Review = Schema.Struct({ issues: Schema.Array(Issue) });

export const Action = Schema.Literals([
  "accepted",
  "partially_accepted",
  "rejected",
  "no_change_needed",
  "clarification_requested",
]);

export const Disposition = Schema.Struct({
  id: Schema.String,
  action: Action,
  rationale: Schema.String,
  duplicate_of: Schema.String,
  reverses: Schema.String,
});

export const SelfCorrection = Schema.Struct({
  id: Schema.String,
  new_action: Schema.Literals(["accepted", "rejected", "plan_error"]),
  explanation: Schema.String,
});

/** The fields that every response to a review has. Spread into the question-list response. */
const plannerResponseFields = {
  dispositions: Schema.Array(Disposition),
  self_corrections: Schema.Array(SelfCorrection),
  reviewer_feedback: Schema.String,
  questions_for_user: Schema.Array(Schema.String),
};

export const PlannerResponse = Schema.Struct(plannerResponseFields);

export const PlanWriteResult = Schema.Struct({ questions_for_user: Schema.Array(Schema.String) });

/** One entry of the question list that Claude Code and Codex agree on before the interview. */
export const QuestionEntry = Schema.Struct({
  id: Schema.String,
  question: Schema.String,
  reason: Schema.String,
  proposed_answers: Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String })),
  default_answer: Schema.String,
});

export const QuestionList = Schema.Struct({ questions: Schema.Array(QuestionEntry) });

/** A response to a review of the question list: the dispositions and the complete amended list. */
export const QuestionListResponse = Schema.Struct({
  ...plannerResponseFields,
  questions: Schema.Array(QuestionEntry),
});

/** Claude Code's output for one turn of the interview. */
export const InterviewTurn = Schema.Struct({
  message_to_user: Schema.String,
  answered_ids: Schema.Array(Schema.String),
  complete: Schema.Boolean,
  summary: Schema.String,
});

export const ExecReport = Schema.Struct({
  status: Schema.Literals(["finished", "needs_input", "blocked"]),
  summary: Schema.String,
  question: Schema.String,
  remaining_work: Schema.String,
});

export const ExecOutcome = Schema.Struct({
  status: Schema.Literals(["finished", "needs_input", "blocked", "aborted"]),
  summary: Schema.String,
  question: Schema.String,
  remainingWork: Schema.String,
  // Set when the user's input was already read during the phase (a question from Claude Code).
  userInput: Schema.NullOr(Schema.String),
});

export const LogEntry = Schema.Struct({
  id: Schema.String,
  phase: Schema.Finite,
  round: Schema.Finite,
  source: Schema.Literals(["review", "self_correction", "user"]),
  severity: Schema.optionalKey(Severity),
  location: Schema.optionalKey(Schema.String),
  problem: Schema.String,
  evidence: Schema.optionalKey(Schema.String),
  action: Schema.String,
  rationale: Schema.String,
  duplicate_of: Schema.optionalKey(Schema.String),
  reverses: Schema.optionalKey(Schema.String),
  superseded: Schema.optionalKey(Schema.Boolean),
});

export const Config = Schema.Struct({
  questionPhase: Schema.Boolean,
  /** Paths relative to the project that the change detection ignores. A directory covers everything below it. */
  ignorePaths: Schema.Array(Schema.String),
  maxRounds: Schema.Finite,
  maxIdleRounds: Schema.Finite,
  countMinor: Schema.Boolean,
  execPermissionMode: Schema.Literals(["auto", "acceptEdits", "bypassPermissions", "default"]),
  claudeModel: Schema.NullOr(Schema.String),
  codexModel: Schema.NullOr(Schema.String),
});

/** A config file: any subset of the keys of Config. Unknown keys are rejected where it is decoded. */
export const PartialConfig = Config.mapFields(Struct.map(Schema.optionalKey));

/** plan-review/questions.json: the task and the agreed list. */
export const QuestionsFile = Schema.Struct({
  task: Schema.String,
  questions: Schema.Array(QuestionEntry),
});

/**
 * One line of plan-review/usage.jsonl. The reported fields differ per agent and may grow with the
 * SDKs, so a line is decoded with excess properties ignored, and only the summed fields are named.
 */
export const UsageEntry = Schema.Struct({
  time: Schema.String,
  agent: Schema.String,
  session_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  thread_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  num_turns: Schema.optionalKey(Schema.Finite),
  total_cost_usd: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  usage: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ input_tokens: Schema.optionalKey(Schema.Finite), output_tokens: Schema.optionalKey(Schema.Finite) })),
  ),
});

// The types, under the names the program used before the schemas existed.
export type Severity = typeof Severity.Type;
export type Issue = typeof Issue.Type;
export type Review = typeof Review.Type;
export type Action = typeof Action.Type;
export type Disposition = typeof Disposition.Type;
export type SelfCorrection = typeof SelfCorrection.Type;
export type PlannerResponse = typeof PlannerResponse.Type;
export type PlanWriteResult = typeof PlanWriteResult.Type;
export type QuestionEntry = typeof QuestionEntry.Type;
export type QuestionList = typeof QuestionList.Type;
export type QuestionListResponse = typeof QuestionListResponse.Type;
export type InterviewTurn = typeof InterviewTurn.Type;
export type ExecReport = typeof ExecReport.Type;
export type ExecOutcome = typeof ExecOutcome.Type;
export type LogEntry = typeof LogEntry.Type;
export type Config = typeof Config.Type;
export type QuestionsFile = typeof QuestionsFile.Type;
export type UsageEntry = typeof UsageEntry.Type;

/** The first problem of a failed decode: the field path (`a.b[0]`, or "" at the root) and the message. */
export const firstIssue = (error: Schema.SchemaError): { path: string; message: string } => {
  const { issues } = formatIssue(error.issue);
  const first = issues[0];
  // A segment is a key, or an object that carries the key (Standard Schema's PathSegment).
  const keys = Array.from(first?.path ?? [], (segment) => (typeof segment === "object" && segment !== null ? segment.key : segment));
  const path = keys.map((key, i) => (typeof key === "number" ? `[${key}]` : i === 0 ? String(key) : `.${String(key)}`)).join("");
  return { path, message: first?.message ?? error.message };
};
const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1({ leafHook: SchemaIssue.defaultLeafHook });

export const defaultConfig: Config = {
  questionPhase: true,
  ignorePaths: [],
  maxRounds: 5,
  maxIdleRounds: 2,
  countMinor: true,
  execPermissionMode: "auto",
  claudeModel: null,
  codexModel: null,
};
