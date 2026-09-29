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

/**
 * A question for the user (decision Q1 of the decision-support task): its text and, when it is a choice, its options
 * (two or more mutually exclusive options; an empty list otherwise). A question with two or more options carries the
 * offer of decision support.
 */
/**
 * A word or phrase in a question that a reader who has never seen the codebase may not know, with its explanation (issue
 * #36). Bound to its exact words (decision Q5): the page marks every case-sensitive, whole-word occurrence. Both fields
 * are plain strings for the agents; `validateQuestion` in src/question.ts rejects a blank one with its repair turn.
 */
export const Term = Schema.Struct({ term: Schema.String, explanation: Schema.String });
/** An option of a question: a short label and a description. */
export const QuestionOption = Schema.Struct({ label: Schema.String, description: Schema.String });
/**
 * A question for the user (decision Q1 of the decision-support task; S3 of the task of issues #46 and #59): the context
 * paragraph that precedes it, its text, the explanations of its terms and, when it is a choice, its options (two or more
 * mutually exclusive options; an empty list otherwise). A question with two or more options carries the offer of
 * decision support.
 */
export const UserQuestion = Schema.Struct({
  context: Schema.String,
  question: Schema.String,
  terms: Schema.Array(Term),
  options: Schema.Array(QuestionOption),
});
/** The reply of a context call (S9, decision Q1): the context paragraph and the terms of a question the program composed. */
export const QuestionContext = Schema.Struct({ context: Schema.String, terms: Schema.Array(Term) });

/** The fields that every response to a review has. Spread into the question-list response. */
const plannerResponseFields = {
  dispositions: Schema.Array(Disposition),
  self_corrections: Schema.Array(SelfCorrection),
  reviewer_feedback: Schema.String,
  questions_for_user: Schema.Array(UserQuestion),
};

export const PlannerResponse = Schema.Struct(plannerResponseFields);

export const PlanWriteResult = Schema.Struct({ questions_for_user: Schema.Array(UserQuestion) });

// ---- the plan as data (issue #6, decisions Q1 and F1) ------------------------------------------------

/**
 * A step of the plan as Claude Code returns it: an id it keeps across revisions (G-R1-1), its number within its stage
 * (display only), a short label and its full text in Markdown. The status is the program's, never the agent's.
 */
export const PlanStep = Schema.Struct({ id: Schema.String, number: Schema.Int, label: Schema.String, text: Schema.String });
/** A stage of the plan: its number (display only), its title and its steps. */
export const PlanStage = Schema.Struct({ number: Schema.Int, title: Schema.String, steps: Schema.Array(PlanStep) });
/** The whole plan, as every call that creates or changes it returns it (F1). */
export const Plan = Schema.Struct({ stages: Schema.Array(PlanStage) });
/** The plan write, its revision and the application of the user's decisions to it. */
export const PlanWrite = Schema.Struct({ plan: Plan, questions_for_user: Schema.Array(UserQuestion) });
/** A response to a review of the plan, with the complete amended plan. */
export const PlanResponse = Schema.Struct({ ...plannerResponseFields, plan: Plan });

/** What the program records of a step (G-R1-2): reported started or done by report_step, unfinished when a call ended with it started. */
export const StepStatus = Schema.Literals(["pending", "started", "done", "unfinished"]);
export const RecordedStep = Schema.Struct({ ...PlanStep.fields, status: StepStatus });
export const RecordedStage = Schema.Struct({ ...PlanStage.fields, steps: Schema.Array(RecordedStep) });
export const RecordedPlan = Schema.Struct({ stages: Schema.Array(RecordedStage) });
/** plan-review/plan.json: the plan with the status of each step, the reviewed file of the plan subject (F1). */
export const PlanFile = Schema.Struct({ version: Schema.Literal(2), plan: RecordedPlan });

// ---- decision support: the representation of docs/decision-making.md ------------------------------

/**
 * An argument against one element of an entry (a counterargument), whose replies are its defenses, whose replies are
 * further counterarguments, without limit ("Counterarguments"). `equivalent_to` is the id of an entry that the argument
 * is equivalent to or reverses ("Reversals", "Equivalence symbols"), or "". The program assigns the symbols.
 */
export type Argument = { readonly id: string; readonly text: string; readonly equivalent_to: string; readonly replies: readonly Argument[] };
export const Argument: Schema.Codec<Argument> = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  equivalent_to: Schema.String,
  replies: Schema.Array(Schema.suspend((): Schema.Codec<Argument> => Argument)),
});
/** One element of an entry: its sentences, and the counterarguments that dispute it, placed right after it. */
export const Element = Schema.Struct({ text: Schema.String, counterarguments: Schema.Array(Argument) });
/** An advantage or a disadvantage: its title and the seven elements; the extent has four parts ("Elements of an advantage or disadvantage"). */
export const Entry = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  comparative_condition: Element,
  starting_cause: Element,
  intermediate_steps: Element,
  threshold: Element,
  effect_on_persons: Element,
  reason_the_effect_matters: Element,
  extent: Schema.Struct({ per_person: Element, persons_affected: Element, likelihood: Element, timing: Element }),
});
/** The column of an option argued from: its advantages, then its disadvantages. */
export const ArguedColumn = Schema.Struct({ kind: Schema.Literal("argued"), option: Schema.String, advantages: Schema.Array(Entry), disadvantages: Schema.Array(Entry) });
/**
 * The column of an option whose meaning is unclear (issue #35, decision Q8): no arguments, only what is unclear and which
 * readings are possible ("Inputs" of docs/decision-making.md).
 */
export const UnclearColumn = Schema.Struct({ kind: Schema.Literal("unclear"), option: Schema.String, unclear: Schema.String });
/** One column per option, argued or unclear. */
export const Column = Schema.Union([ArguedColumn, UnclearColumn]);
/** The representation. The root is an object (a bare $ref root is rejected by the Agent SDK); an empty `recommendation.option` is none. */
export const DecisionAnalysis = Schema.Struct({
  decision: Schema.String,
  columns: Schema.Array(Column),
  recommendation: Schema.Struct({ option: Schema.String, reason: Schema.String }),
});

/** One entry of the question list that Claude Code and Codex agree on before the interview. */
export const QuestionEntry = Schema.Struct({
  id: Schema.String,
  /** The context paragraph that precedes the question (S3); its terms come from the terms subject after convergence (Q8). */
  context: Schema.String,
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

/**
 * The explanations of the terms of the agreed questions (S17, issue #36, decision Q8): one entry per question id, with
 * the terms of the question, its context, its reason, its proposed answers and its default. The reply of the call that
 * writes them and of the application of the user's decisions; plan-review/terms.json holds them.
 */
export const TermsEntry = Schema.Struct({ id: Schema.String, terms: Schema.Array(Term) });
export const TermsWrite = Schema.Struct({ entries: Schema.Array(TermsEntry) });
/** A response to a review of the explanations: the dispositions and the complete amended explanations. */
export const TermsResponse = Schema.Struct({ ...plannerResponseFields, entries: Schema.Array(TermsEntry) });

/** A response to a review of a decision analysis: the dispositions and the complete amended analysis. */
export const DecisionResponse = Schema.Struct({ ...plannerResponseFields, analysis: DecisionAnalysis });
/** The output of applying the user's decisions to an analysis. */
export const DecisionApplied = Schema.Struct({ analysis: DecisionAnalysis });

/**
 * Claude Code's output for one turn of the interview. `asked_ids`: every question asked so far, the agreed ids and the
 * ids Claude assigns to follow-ups (issue #21); `answered_ids`: those of them the user has answered.
 */
export const InterviewTurn = Schema.Struct({
  message_to_user: Schema.String,
  /**
   * Issue #35 (Q5, Q6): the question the message asks the user to answer now, its id and its text alone; S3: with its
   * context paragraph, its terms and its options. Every field empty when the message asks none.
   */
  current_question: Schema.Struct({ id: Schema.String, context: Schema.String, text: Schema.String, terms: Schema.Array(Term), options: Schema.Array(QuestionOption) }),
  asked_ids: Schema.Array(Schema.String),
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

// Constraints for the program's own records (finding 5 of docs/functional-design-review.md). The seven agent
// schemas are unchanged, so the JSON Schema the agents receive is unchanged.
const safeInteger = Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER);
/** An integer ≥ 1 within the safe range: round limits. */
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), safeInteger);
/** An integer ≥ 0 within the safe range: phases, rounds, turn and token counts. */
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), safeInteger);
/** A finite number ≥ 0: costs. */
export const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** An issue id: a non-empty identifier, never prose (recommendation B). */
export const IssueId = Schema.NonEmptyString.pipe(Schema.brand("IssueId"));
export type IssueId = typeof IssueId.Type;

/** The fields every entry of an issue log has. `superseded` is required (Q5): true when a later entry has the same id. */
const logEntryBase = { id: IssueId, phase: NonNegativeInt, round: NonNegativeInt, problem: Schema.String, rationale: Schema.String, superseded: Schema.Boolean };
/**
 * What the program measured of the reviewed file during the planner's response of a round (issue #31): whether it
 * changed at all, and the lines added and removed. One response makes one set of edits, so every entry of the round
 * carries the same value; null where nothing is measured (the work review, Q7).
 */
export const FileChange = Schema.Struct({ changed: Schema.Boolean, added: NonNegativeInt, removed: NonNegativeInt });
export type FileChange = typeof FileChange.Type;
/** The name of that field in the log entries, as the reviewer's prompt names it (src/prompts.ts logRules). */
export const FILE_CHANGE_FIELD = "file_change";
/** An issue Codex raised, with Claude Code's disposition; a reference names an earlier issue or is null. */
export const ReviewEntry = Schema.Struct({
  ...logEntryBase,
  source: Schema.Literal("review"),
  severity: Severity,
  location: Schema.String,
  evidence: Schema.String,
  action: Action,
  duplicate_of: Schema.NullOr(IssueId),
  reverses: Schema.NullOr(IssueId),
  [FILE_CHANGE_FIELD]: Schema.NullOr(FileChange),
});
/** A correction Claude Code made to its own earlier work. */
export const SelfCorrectionEntry = Schema.Struct({
  ...logEntryBase,
  source: Schema.Literal("self_correction"),
  action: Schema.Literals(["accepted", "plan_error", "correction_disputed"]),
  [FILE_CHANGE_FIELD]: Schema.NullOr(FileChange),
});
/** A decision of the user on one issue. */
export const UserEntry = Schema.Struct({ ...logEntryBase, source: Schema.Literal("user"), action: Schema.Literal("decided_by_user") });
/** One entry of an issue log, tagged by `source` (finding 6; Q5). */
export const LogEntry = Schema.Union([ReviewEntry, SelfCorrectionEntry, UserEntry]);

export const Config = Schema.Struct({
  questionPhase: Schema.Boolean,
  /** Paths relative to the project that the change detection ignores. A directory covers everything below it. */
  ignorePaths: Schema.Array(Schema.String),
  maxRounds: PositiveInt,
  maxIdleRounds: PositiveInt,
  /** Issue #26, Q1: the retries of a call that failed from a transport fault, before the user is asked. */
  maxTransportRetries: PositiveInt,
  /** The wait before the first retry in seconds; it doubles on each further retry. */
  transportRetryDelaySeconds: Schema.Finite.check(Schema.isGreaterThan(0)),
  countMinor: Schema.Boolean,
  execPermissionMode: Schema.Literals(["auto", "acceptEdits", "bypassPermissions", "default"]),
  claudeModel: Schema.NullOr(Schema.String),
  codexModel: Schema.NullOr(Schema.String),
});

/** A config file: any subset of the keys of Config. Unknown keys are rejected where it is decoded. */
export const PartialConfig = Config.mapFields(Struct.map(Schema.optionalKey));

/** plan-review/questions.json: the task and the agreed list. Unlike the agent schema, an entry's id must not be empty. */
export const QuestionsFile = Schema.Struct({
  version: Schema.Literal(2),
  task: Schema.String,
  /** A default that named none of the proposed answers is null (step 4.6). */
  questions: Schema.Array(Schema.Struct({ ...QuestionEntry.fields, id: Schema.NonEmptyString, default_answer: Schema.NullOr(Schema.String) })),
});

/** One line of plan-review/usage.jsonl, version 2: the fields the program reads, per agent (finding 9; Q5). */
export const ClaudeUsage = Schema.Struct({
  version: Schema.Literal(2),
  agent: Schema.Literal("claude"),
  time: Schema.String,
  session: Schema.NullOr(Schema.String),
  num_turns: Schema.NullOr(NonNegativeInt),
  total_cost_usd: Schema.NullOr(NonNegativeFinite),
});
export const CodexUsage = Schema.Struct({
  version: Schema.Literal(2),
  agent: Schema.Literal("codex"),
  time: Schema.String,
  thread: Schema.NullOr(Schema.String),
  input_tokens: NonNegativeInt,
  output_tokens: NonNegativeInt,
});
export const UsageRecord = Schema.Union([ClaudeUsage, CodexUsage]);

// The types, under the names the program used before the schemas existed.
export type Severity = typeof Severity.Type;
export type Issue = typeof Issue.Type;
export type Review = typeof Review.Type;
export type Action = typeof Action.Type;
export type Disposition = typeof Disposition.Type;
export type SelfCorrection = typeof SelfCorrection.Type;
export type UserQuestion = typeof UserQuestion.Type;
export type Term = typeof Term.Type;
export type QuestionOption = typeof QuestionOption.Type;
export type QuestionContext = typeof QuestionContext.Type;
export type TermsEntry = typeof TermsEntry.Type;
export type TermsWrite = typeof TermsWrite.Type;
export type TermsResponse = typeof TermsResponse.Type;
export type PlannerResponse = typeof PlannerResponse.Type;
export type PlanWriteResult = typeof PlanWriteResult.Type;
export type PlanStep = typeof PlanStep.Type;
export type Plan = typeof Plan.Type;
export type PlanWrite = typeof PlanWrite.Type;
export type PlanResponse = typeof PlanResponse.Type;
export type StepStatus = typeof StepStatus.Type;
export type RecordedStep = typeof RecordedStep.Type;
export type RecordedPlan = typeof RecordedPlan.Type;
export type PlanFile = typeof PlanFile.Type;
export type QuestionEntry = typeof QuestionEntry.Type;
export type QuestionList = typeof QuestionList.Type;
export type QuestionListResponse = typeof QuestionListResponse.Type;
export type InterviewTurn = typeof InterviewTurn.Type;
export type Element = typeof Element.Type;
export type Entry = typeof Entry.Type;
export type Column = typeof Column.Type;
export type ArguedColumn = typeof ArguedColumn.Type;
export type UnclearColumn = typeof UnclearColumn.Type;
export type DecisionAnalysis = typeof DecisionAnalysis.Type;
export type DecisionResponse = typeof DecisionResponse.Type;
export type DecisionApplied = typeof DecisionApplied.Type;
export type ExecReport = typeof ExecReport.Type;
export type ExecOutcome = typeof ExecOutcome.Type;
export type LogEntry = typeof LogEntry.Type;
export type ReviewEntry = typeof ReviewEntry.Type;
export type Config = typeof Config.Type;
export type QuestionsFile = typeof QuestionsFile.Type;
export type UsageRecord = typeof UsageRecord.Type;

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
  maxTransportRetries: 3,
  transportRetryDelaySeconds: 5,
  countMinor: true,
  execPermissionMode: "auto",
  claudeModel: null,
  codexModel: null,
};
