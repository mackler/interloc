// The messages between the web page and the server (plan step 3.1), as Effect schemas so that both sides decode
// the same way. Pure: no Node import (the browser imports this module).

import { Result, Schema } from "effect";
import * as S from "./schema.ts";
import type { UiEvent } from "./uiEvents.ts";
import type { Choice, Extra, PromptKind } from "./userPrompts.ts";


/** A prompt the run waits on, with its widget (src/userPrompts.ts). `prompt` numbers the prompts of a run. */
export type Asked = Readonly<{ _tag: "Asked"; prompt: number; text: string; kind: PromptKind; mode: "ask" | "message"; choices: readonly Choice[]; free: "none" | "line" | "message"; extra: Extra }>;
/** What happened in a run, in order: the run's Ui calls and its start and end. */
export type RunEvent =
  | Readonly<{ _tag: "Started"; project: string; task: string; time: string }>
  | Readonly<{ _tag: "Said"; text: string }>
  | Asked
  | Readonly<{ _tag: "Answered"; prompt: number; text: string }>
  | Readonly<{ _tag: "Notified"; event: UiEvent }>
  | Readonly<{ _tag: "Ended"; code: number }>;
export type RunRecord = Readonly<{ id: number; events: readonly RunEvent[] }>;
/**
 * The incarnation (finding 12 of docs/gui-review.md) names one start of the server: run and prompt numbers restart
 * with the server, so an answer or a stop carries the incarnation it was made in, and the hello says which one is live.
 */
export type ClientMessage =
  | Readonly<{ type: "start"; project: string; task: string }>
  | Readonly<{ type: "answer"; incarnation: string; run: number; prompt: number; text: string }>
  | Readonly<{ type: "stop"; incarnation: string; run: number }>
  | Readonly<{ type: "list"; path: string }>;
export type ServerMessage =
  | Readonly<{ type: "hello"; cwd: string; current: number | null; incarnation: string }>
  | Readonly<{ type: "replay"; runs: readonly RunRecord[] }>
  | Readonly<{ type: "event"; run: number; seq: number; event: RunEvent }>
  | Readonly<{ type: "listing"; path: string; parent: string | null; dirs: readonly string[]; error: string | null }>
  | Readonly<{ type: "refused"; reason: string }>
  /** The server is ending (finding 15 of docs/gui-review.md); the tab's socket is closed after this. */
  | Readonly<{ type: "closing" }>;

const Int = S.NonNegativeInt;
const Str = Schema.String;
const tagged = <const T extends string, F extends Schema.Struct.Fields>(tag: T, fields: F) => Schema.Struct({ _tag: Schema.Literal(tag), ...fields });
const typed = <const T extends string, F extends Schema.Struct.Fields>(type: T, fields: F) => Schema.Struct({ type: Schema.Literal(type), ...fields });

const SubjectIdSchema = Schema.Union([Schema.Literal("questions"), Schema.Literal("requirements"), Schema.Struct({ plan: Int }), Schema.Struct({ work: Int })]);
const PhaseSchema = Schema.Union([Schema.Struct({ kind: Schema.Literal("questions") }), Schema.Struct({ kind: Schema.Literals(["planning", "execution", "work"]), n: Int })]);
const AgentSchema = Schema.Literals(["claude", "codex"]);
const round = { subject: SubjectIdSchema, round: Int };

/** UiEvent of src/uiEvents.ts, variant by variant. */
export const UiEventSchema = Schema.Union([
  tagged("PhaseBegan", { phase: PhaseSchema }),
  tagged("PhaseEnded", { phase: PhaseSchema, result: Str }),
  tagged("RoundBegan", { ...round, limit: Int }),
  tagged("ReviewReceived", { ...round, review: S.Review, counted: Int }),
  // The question subject's response is the planner's plus `questions` (defect A of docs/page-question-phase-defects.md).
  tagged("ResponseReceived", { ...round, response: Schema.Union([S.QuestionListResponse, S.PlannerResponse]), resultText: Str }),
  tagged("LoopFinished", { subject: SubjectIdSchema, result: Schema.Literals(["converged", "proceed", "revise"]) }),
  tagged("PlanWritten", { phase: Int, questions: Schema.Array(Str), resultText: Str }),
  tagged("ExecutionEnded", { phase: Int, outcome: S.ExecOutcome }),
  tagged("AgentCallStarted", { agent: AgentSchema, purpose: Str }),
  tagged("ToolUsed", { agent: AgentSchema, tool: Str, target: Str }),
  tagged("AgentCallEnded", { agent: AgentSchema, ok: Schema.Boolean }),
  tagged("QuestionAsked", { question: Str, options: Schema.Array(Schema.Struct({ label: Str, description: Str })) }),
  tagged("InterviewTurn", { heading: Str, message: Str, summary: Schema.NullOr(Str) }),
  tagged("InterviewOpened", { heading: Str }),
]);

const ChoiceSchema = Schema.Struct({ label: Str, sends: Str });
export const RunEventSchema = Schema.Union([
  tagged("Started", { project: Str, task: Str, time: Str }),
  tagged("Said", { text: Str }),
  tagged("Asked", {
    prompt: Int,
    text: Str,
    kind: Schema.Literals(["decision", "limit", "limitNoProceed", "execInput", "optionOrText", "permission", "interviewMessage", "confirmSummary", "startOrTalk", "unknown"]),
    mode: Schema.Literals(["ask", "message"]),
    choices: Schema.Array(ChoiceSchema),
    free: Schema.Literals(["none", "line", "message"]),
    extra: Schema.Literals(["none", "questionOptions", "numberedAnswers"]),
  }),
  tagged("Answered", { prompt: Int, text: Str }),
  tagged("Notified", { event: UiEventSchema }),
  tagged("Ended", { code: Int }),
]);
const RunRecordSchema = Schema.Struct({ id: Int, events: Schema.Array(RunEventSchema) });

export const ClientMessageSchema = Schema.Union([
  typed("start", { project: Str, task: Str }),
  typed("answer", { incarnation: Str, run: Int, prompt: Int, text: Str }),
  typed("stop", { incarnation: Str, run: Int }),
  typed("list", { path: Str }),
]);
export const ServerMessageSchema = Schema.Union([
  typed("hello", { cwd: Str, current: Schema.NullOr(Int), incarnation: Str }),
  typed("replay", { runs: Schema.Array(RunRecordSchema) }),
  typed("event", { run: Int, seq: Int, event: RunEventSchema }),
  typed("listing", { path: Str, parent: Schema.NullOr(Str), dirs: Schema.Array(Str), error: Schema.NullOr(Str) }),
  typed("refused", { reason: Str }),
  typed("closing", {}),
]);

// The declared types and the schemas' types are the same: each is assignable to the other.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same = <T extends true>(): T | undefined => undefined;
void same<Same<typeof UiEventSchema.Type, UiEvent>>();
void same<Same<typeof RunEventSchema.Type, RunEvent>>();
void same<Same<typeof ClientMessageSchema.Type, ClientMessage>>();
void same<Same<typeof ServerMessageSchema.Type, ServerMessage>>();

const strict = { onExcessProperty: "error" as const };
const decodeWith = <A>(schema: Schema.Decoder<A>) => {
  const decode = Schema.decodeUnknownResult(schema, strict);
  return (text: string): Result.Result<A, string> => {
    const json = Result.try({ try: () => JSON.parse(text) as unknown, catch: () => "not JSON" });
    if (Result.isFailure(json)) return Result.fail(json.failure);
    const value = decode(json.success);
    return Result.isSuccess(value) ? Result.succeed(value.success) : Result.fail(value.failure.message);
  };
};
/** A frame of the page, decoded; the reason when it is not a message. */
export const decodeClient: (text: string) => Result.Result<ClientMessage, string> = decodeWith<ClientMessage>(ClientMessageSchema);
/** A frame of the server, decoded; the reason when it is not a message. */
export const decodeServer: (text: string) => Result.Result<ServerMessage, string> = decodeWith<ServerMessage>(ServerMessageSchema);

/** Whether an event is already in the replay: its run is replayed and its seq is below that run's event count (P1-R1-2). */
export const inSnapshot = (runs: readonly RunRecord[], message: Readonly<{ run: number; seq: number }>): boolean =>
  runs.some((r) => r.id === message.run && message.seq < r.events.length);
