// Claude Code through the Claude Agent SDK, as the Planner service.

import type { CanUseTool, HookCallback, Options, PermissionResult, PreToolUseHookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Exit, Layer, Ref, Schema } from "effect";
import * as path from "node:path";
import { ClaudeCallFailed, isRunError, type UserStopped } from "./errors.ts";
import { chooseOption } from "./input.ts";
import { agentJsonSchema } from "./jsonSchema.ts";
import * as S from "./schema.ts";
import type { ExecReport } from "./schema.ts";
import { Planner, type PlannerShape, RunConfig, Sdk, Store, type StoreError, Ui } from "./services.ts";

const EDIT_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

type Question = { question: string; options: { label: string; description: string }[] };
type Stop = { question: string; input: string };
type CallResult = { structured: unknown; resultText: string; costUsd: number | null; error: string | null };
/** What a callback of the SDK can fail with: the user stopping, or a record that could not be written. */
type CallbackError = UserStopped | StoreError;
/** Runs an Effect inside a callback of the SDK; on failure the call is aborted and `fallback` is answered. */
type InCallback = <A>(effect: Effect.Effect<A, CallbackError>, fallback: A) => Promise<A>;

/**
 * The answers as the SDK wants them: an object keyed by question text. Answers are collected by question
 * index, so two questions with the same text are answered separately; in the object the later one wins,
 * and `duplicates` names the texts for which that happened (finding 18 / 8 of the functional design review).
 */
export const toSdkAnswers = (questions: readonly { readonly question: string }[], answers: ReadonlyMap<number, string>): { answers: Record<string, string>; duplicates: readonly string[] } => {
  const object: Record<string, string> = {};
  const duplicates: string[] = [];
  questions.forEach((q, index) => {
    const answer = answers.get(index);
    if (answer === undefined) return;
    if (q.question in object && !duplicates.includes(q.question)) duplicates.push(q.question);
    object[q.question] = answer;
  });
  return { answers: object, duplicates };
};

const decodeExecReport = Schema.decodeUnknownSync(S.ExecReport);
/** The status report of an execution call, or null if there is none or it does not match its schema. */
const execReport = (structured: unknown): ExecReport | null => {
  try {
    return decodeExecReport(structured);
  } catch (e) {
    if (Schema.isSchemaError(e)) return null;
    throw e;
  }
};

/** The Planner service over the SDK, Ui, Store and RunConfig services. */
export const makeClaudePlanner: Effect.Effect<PlannerShape, never, Sdk | Ui | Store | RunConfig> = Effect.gen(function* () {
  const sdk = yield* Sdk;
  const ui = yield* Ui;
  const store = yield* Store;
  const config = yield* RunConfig;
  const allowedDir = store.dir + path.sep;
  const session = yield* Ref.make<string | null>(null);
  const stop = yield* Ref.make<Stop | null>(null);

  /** Asks the user each question; the answers are keyed by the question's index, so equal texts stay apart. */
  const relayQuestions = (questions: readonly Question[]): Effect.Effect<ReadonlyMap<number, string>, CallbackError> =>
    Effect.gen(function* () {
      const answers = new Map<number, string>();
      for (const [index, q] of questions.entries()) {
        yield* ui.say(`\nQuestion from Claude Code: ${q.question}`);
        for (const [i, o] of q.options.entries()) yield* ui.say(`  ${i + 1}. ${o.label} - ${o.description}`);
        let reply = "";
        while (reply === "") reply = yield* ui.ask("Number or free text (q = quit) > ");
        const chosen = chooseOption(reply, q.options.length);
        const answer = chosen === null ? reply : q.options[chosen].label;
        answers.set(index, answer);
        yield* store.converse(`**Question from Claude Code:** ${q.question}\n\n**User answer:** ${answer}\n\n`);
      }
      return answers;
    });
  /** The SDK object, with one note in the record when two questions shared a text (the later answer is delivered). */
  const sdkAnswers = (questions: readonly Question[], answers: ReadonlyMap<number, string>): Effect.Effect<Record<string, string>, CallbackError> =>
    Effect.gen(function* () {
      const edge = toSdkAnswers(questions, answers);
      if (edge.duplicates.length > 0) yield* store.converse(`**Duplicate question text:** ${edge.duplicates.join("; ")} — the answer to the later question is the one Claude Code receives.\n\n`);
      return edge.answers;
    });

  // Planning: deny every file edit whose target is outside plan-review/. A hook runs before the
  // permission evaluation, so the denial applies in every permission mode.
  const restrictEdits: HookCallback = async (input) => {
    const pre = input as PreToolUseHookInput;
    const toolInput = pre.tool_input as Record<string, unknown>;
    const target = path.resolve(store.project, String(toolInput?.file_path ?? toolInput?.notebook_path ?? ""));
    if (target.startsWith(allowedDir)) return {};
    return {
      hookSpecificOutput: {
        hookEventName: pre.hook_event_name,
        permissionDecision: "deny",
        permissionDecisionReason: "During a planning phase, only files under plan-review/ may be written.",
      },
    };
  };

  // Execution: after Claude Code has asked the user a question, deny every further tool call, so
  // that the turn ends and the plan is revised and reviewed before work continues.
  // The StructuredOutput tool carries the final status report, so it stays permitted.
  const denyAfterStop: HookCallback = async (input) => {
    if ((await Effect.runPromise(Ref.get(stop))) === null) return {};
    const pre = input as PreToolUseHookInput;
    if (pre.tool_name === "StructuredOutput") return {};
    return {
      hookSpecificOutput: {
        hookEventName: pre.hook_event_name,
        permissionDecision: "deny",
        permissionDecisionReason: "Execution is stopped. Make no tool call other than the final structured output, and end your turn with status 'needs_input'.",
      },
    };
  };

  const planningPermission =
    (inCallback: InCallback): CanUseTool =>
    async (toolName, input): Promise<PermissionResult> => {
      if (toolName === "AskUserQuestion") {
        const questions = (input.questions ?? []) as Question[];
        const answers = await inCallback(relayQuestions(questions).pipe(Effect.flatMap((a) => sdkAnswers(questions, a))), {});
        return { behavior: "allow", updatedInput: { questions, answers } };
      }
      if (EDIT_TOOLS.includes(toolName)) return { behavior: "allow", updatedInput: input };
      return { behavior: "deny", message: "During a planning phase, only reading and writing under plan-review/ are permitted." };
    };

  const executionPermission =
    (inCallback: InCallback): CanUseTool =>
    async (toolName, input): Promise<PermissionResult> => {
      if (toolName === "AskUserQuestion") {
        const questions = (input.questions ?? []) as Question[];
        await inCallback(
          Effect.gen(function* () {
            yield* ui.say("\nClaude Code has stopped execution with a question.");
            const answers = yield* relayQuestions(questions);
            yield* Ref.set(stop, {
              question: questions.map((q) => q.question).join(" / "),
              input: [...answers].map(([index, a]) => `${questions[index].question} -> ${a}`).join("; "),
            });
          }),
          undefined,
        );
        return {
          behavior: "deny",
          message: "The user's answer is recorded in plan-review/user-decisions.md. Do not continue the implementation. Make no tool call other than the final structured output, and end your turn with status 'needs_input', a summary, and the remaining work. The plan will be revised and reviewed before work continues.",
        };
      }
      const allowed = await inCallback(
        Effect.gen(function* () {
          yield* ui.say(`\nClaude Code requests permission: ${toolName} ${JSON.stringify(input)}`);
          const reply = yield* ui.ask("Allow? (y = yes, anything else = no, q = quit) > ");
          return reply.toLowerCase() === "y";
        }),
        false,
      );
      if (allowed) return { behavior: "allow", updatedInput: input };
      return { behavior: "deny", message: "The user denied this action." };
    };

  /**
   * One SDK call. The messages are consumed inside the Effect, so an interruption aborts the call
   * through the SDK's AbortController. A callback runs its Effects through the runtime; if one fails,
   * the failure is kept, the call is aborted, and the call fails with it.
   */
  const call = (prompt: string, show: "none" | "tools" | "text", options: Options, permission: (inCallback: InCallback) => CanUseTool): Effect.Effect<CallResult, CallbackError> =>
    Effect.gen(function* () {
      const controller = new AbortController();
      let callbackFailure: CallbackError | null = null;
      const inCallback: InCallback = (effect, fallback) =>
        Effect.runPromise(effect, { signal: controller.signal }).catch((e: unknown) => {
          if (!isRunError(e)) throw e;
          callbackFailure ??= e as CallbackError;
          controller.abort();
          return fallback;
        });
      const full: Options = { ...options, cwd: store.project, abortController: controller, canUseTool: permission(inCallback) };
      const resumed = yield* Ref.get(session);
      if (resumed !== null) full.resume = resumed;
      if (config.claudeModel !== null) full.model = config.claudeModel;

      const out: CallResult = { structured: null, resultText: "", costUsd: null, error: "the call produced no result message" };
      const failed = (e: unknown): string => (e instanceof Error ? e.message : String(e));
      // Starting the call can throw synchronously (for example when the SDK cannot start its CLI);
      // that is a call error like a failure of the stream, not a defect.
      const started = yield* Effect.try({ try: () => sdk.query({ prompt, options: full })[Symbol.asyncIterator](), catch: failed }).pipe(Effect.catch((text) => Effect.sync(() => ((out.error = text), null))));
      if (started === null) return out;
      const iterator = started;
      /** The next message, or null at the end; a failure of the stream ends the call with its text. */
      const next = (): Effect.Effect<SDKMessage | null> =>
        Effect.tryPromise({ try: () => iterator.next(), catch: (e: unknown) => e }).pipe(
          Effect.map((step) => (step.done ? null : step.value)),
          Effect.catch((e) =>
            Effect.sync(() => {
              out.error = failed(e);
              return null;
            }),
          ),
        );
      const consume = Effect.gen(function* () {
        for (let message = yield* next(); message !== null; message = yield* next()) {
          if (message.type === "system" && message.subtype === "init") {
            yield* Ref.set(session, message.session_id);
          } else if (message.type === "assistant" && show !== "none") {
            for (const block of message.message.content) {
              if (show === "text" && block.type === "text" && block.text.trim() !== "") yield* ui.say(`[claude] ${block.text.trim()}`);
              if (show === "tools" && block.type === "tool_use" && block.name !== "StructuredOutput") {
                const input = block.input as Record<string, unknown>;
                yield* ui.say(`  [claude: ${block.name} ${String(input?.file_path ?? input?.pattern ?? input?.command ?? "")}]`);
              }
            }
          } else if (message.type === "result") {
            out.costUsd = message.total_cost_usd;
            yield* store.recordUsage({ agent: "claude", session_id: yield* Ref.get(session), num_turns: message.num_turns, total_cost_usd: message.total_cost_usd });
            if (message.subtype === "success") {
              out.structured = message.structured_output;
              out.resultText = message.result;
              out.error = null;
            } else {
              out.error = message.subtype;
            }
          }
        }
      });
      // On every early exit — an interruption, or a typed failure such as a record that could not be
      // written — abort the call and close the stream, as the `for await` loop of the Promise version
      // did through the iterator's return(); otherwise the Claude Code process could outlive the halt.
      const close = Effect.promise(async () => {
        controller.abort();
        await iterator.return?.().catch(() => undefined);
      });
      yield* consume.pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.succeed(undefined) : close)));
      if (callbackFailure !== null) return yield* Effect.fail(callbackFailure);
      return out;
    });

  return {
    planning: (prompt, schema, progress = false) =>
      Effect.gen(function* () {
        const result = yield* call(
          prompt,
          progress ? "tools" : "none",
          {
            permissionMode: "default",
            outputFormat: { type: "json_schema", schema: agentJsonSchema(schema) },
            hooks: { PreToolUse: [{ matcher: EDIT_TOOLS.join("|"), hooks: [restrictEdits] }] },
          },
          planningPermission,
        );
        if (result.error !== null) return yield* Effect.fail(new ClaudeCallFailed({ message: result.error }));
        return { output: result.structured, resultText: result.resultText, costUsd: result.costUsd };
      }),
    executing: (prompt) =>
      Effect.gen(function* () {
        yield* Ref.set(stop, null);
        const result = yield* call(
          prompt,
          "text",
          {
            permissionMode: config.execPermissionMode,
            outputFormat: { type: "json_schema", schema: agentJsonSchema(S.ExecReport) },
            hooks: { PreToolUse: [{ hooks: [denyAfterStop] }] },
          },
          executionPermission,
        );
        // A recorded stop takes precedence over any report; an invalid report is treated as a missing one.
        // Execution calls never get a repair turn (decision Q5).
        const report = execReport(result.structured);
        const stopped = yield* Ref.get(stop);
        if (stopped !== null) {
          return { status: "needs_input" as const, summary: report?.summary ?? "", question: stopped.question, remainingWork: report?.remaining_work ?? "", userInput: stopped.input };
        }
        if (result.error !== null || report === null) {
          const reason = result.error ?? (result.structured === null || result.structured === undefined ? "no structured output" : "the status report does not match its schema");
          return { status: "aborted" as const, summary: result.resultText, question: `The execution call ended without a status report: ${reason}`, remainingWork: "", userInput: null };
        }
        return { status: report.status, summary: report.summary, question: report.question, remainingWork: report.remaining_work, userInput: null };
      }),
    sessionId: Ref.get(session),
  };
});

export const claudePlannerLayer: Layer.Layer<Planner, never, Sdk | Ui | Store | RunConfig> = Layer.effect(Planner, makeClaudePlanner);
