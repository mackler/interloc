// Pure decoding of what the Claude Agent SDK hands the planner adapter, and the pure reduction of a
// call's messages into its outcome (findings 17 and 19 of docs/functional-design-review.md). No I/O,
// no Effect services: src/claude.ts keeps stream consumption, cancellation and persistence.

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Result, Schema } from "effect";
import * as S from "./schema.ts";
import type { ExecOutcome, ExecReport } from "./schema.ts";
import { normalizeReport } from "./schemaNormalize.ts";

export type Question = Readonly<{ question: string; options: readonly Readonly<{ label: string; description: string }>[] }>;
/** A recorded AskUserQuestion stop of an execution call. */
export type Stop = Readonly<{ question: string; input: string }>;
/**
 * What one SDK call produced. `error` is null only after a success result. `partial` is true when the
 * stream ended before any result message (an abort or a stream failure): the other fields hold what
 * was retained up to that point. A failed result (`error_max_turns`, …) is a complete call, not partial.
 */
export type CallOutcome = Readonly<{ sessionId: string | null; costUsd: number | null; structured: unknown; resultText: string; error: string | null; partial: boolean }>;

/** The fields of the SDK's AskUserQuestion input that the program reads; the others (header, multiSelect) are ignored. */
const QuestionInput = Schema.Struct({
  questions: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        question: Schema.String,
        options: Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String })),
      }),
    ),
  ),
});
const decodeQuestionInput = Schema.decodeUnknownResult(QuestionInput);

/** The questions of an AskUserQuestion call; a missing list is empty; the failure text names the field. */
export const decodeQuestions = (input: unknown): Result.Result<readonly Question[], string> => {
  const decoded = decodeQuestionInput(input);
  if (Result.isFailure(decoded)) {
    const { path, message } = S.firstIssue(decoded.failure);
    return Result.fail(path === "" ? message : `${path}: ${message}`);
  }
  return Result.succeed(decoded.success.questions ?? []);
};

/** The file an edit tool targets: `file_path`, else `notebook_path`; null when neither is a string. */
export const decodeToolTarget = (toolInput: unknown): string | null => {
  if (typeof toolInput !== "object" || toolInput === null) return null;
  const { file_path, notebook_path } = toolInput as Readonly<Record<string, unknown>>;
  if (typeof file_path === "string") return file_path;
  if (typeof notebook_path === "string") return notebook_path;
  return null;
};

const noResult = "the call produced no result message";
/** The outcome of a call from its messages in order; `streamError` is the text of a failure of the stream, which wins over any result. */
export const reduceMessages = (messages: readonly SDKMessage[], streamError: string | null = null): CallOutcome => {
  const start: CallOutcome = { sessionId: null, costUsd: null, structured: null, resultText: "", error: noResult, partial: true };
  const folded = messages.reduce<CallOutcome>((out, message) => {
    if (message.type === "system" && message.subtype === "init") return { ...out, sessionId: message.session_id };
    if (message.type !== "result") return out;
    return message.subtype === "success"
      ? { ...out, costUsd: message.total_cost_usd, structured: message.structured_output, resultText: message.result, error: null, partial: false }
      : { ...out, costUsd: message.total_cost_usd, error: message.subtype, partial: false };
  }, start);
  return streamError === null ? folded : { ...folded, error: streamError };
};

const decodeExecReport = Schema.decodeUnknownResult(S.ExecReport);
/** The status report of an execution call, or null if there is none or it does not match its schema. */
const execReport = (structured: unknown): ExecReport | null => {
  const decoded = decodeExecReport(structured);
  return Result.isSuccess(decoded) ? decoded.success : null;
};

/**
 * The outcome of an execution phase. A recorded stop takes precedence over any report; an invalid
 * report is treated as a missing one (status aborted). Execution calls never get a repair turn (decision Q5).
 */
export const interpretExecution = (outcome: CallOutcome, stop: Stop | null): ExecOutcome => {
  const report = execReport(outcome.structured);
  if (stop !== null) {
    return { status: "needs_input", summary: report?.summary ?? "", question: stop.question, remainingWork: report?.remaining_work ?? "", userInput: stop.input };
  }
  if (outcome.error !== null || report === null) {
    const reason = outcome.error ?? (outcome.structured === null || outcome.structured === undefined ? "no structured output" : "the status report does not match its schema");
    return { status: "aborted", summary: outcome.resultText, question: `The execution call ended without a status report: ${reason}`, remainingWork: "", userInput: null };
  }
  const variant = normalizeReport(report);
  switch (variant.kind) {
    case "finished":
      return { status: "finished", summary: variant.summary, question: "", remainingWork: variant.remainingWork, userInput: null };
    case "awaiting_input":
      return { status: "needs_input", summary: variant.summary, question: variant.question, remainingWork: variant.remainingWork, userInput: null };
    case "blocked":
      return { status: "blocked", summary: variant.summary, question: variant.description, remainingWork: variant.remainingWork, userInput: null };
  }
};
