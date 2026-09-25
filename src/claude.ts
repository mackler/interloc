// Claude Code through the Claude Agent SDK, as the Planner service. This file keeps stream consumption,
// cancellation, persistence and the SDK's tool-name strings; decoding and reduction are in src/claudeEvents.ts.

import type { CanUseTool, HookCallback, Options, PermissionResult, PreToolUseHookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Deferred, Effect, Exit, Layer, Ref, Result } from "effect";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { type CallOutcome, decodeQuestions, decodeToolTarget, interpretExecution, type Question, reduceMessages, type Stop } from "./claudeEvents.ts";
import { ClaudeCallFailed, type UserStopped } from "./errors.ts";
import { chooseOption } from "./input.ts";
import { agentJsonSchema } from "./jsonSchema.ts";
import * as S from "./schema.ts";
import { Planner, type PlannerShape, RunConfig, Sdk, Store, type StoreError, Ui } from "./services.ts";

const EDIT_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

/** What a callback of the SDK can fail with: the user stopping, a record that could not be written, or malformed callback data. */
type CallbackError = UserStopped | StoreError | ClaudeCallFailed;
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

/** The decoded questions of an AskUserQuestion input, or a typed failure of the call (finding 17). */
const questionsOf = (input: unknown): Effect.Effect<readonly Question[], ClaudeCallFailed> => {
  const decoded = decodeQuestions(input);
  return Result.isSuccess(decoded) ? Effect.succeed(decoded.success) : Effect.fail(new ClaudeCallFailed({ message: `AskUserQuestion input not understood: ${decoded.failure}` }));
};
const deny = (message: string): PermissionResult => ({ behavior: "deny", message });

/** The Planner service over the SDK, Ui, Store and RunConfig services. */
export const makeClaudePlanner: Effect.Effect<PlannerShape, never, Sdk | Ui | Store | RunConfig> = Effect.gen(function* () {
  const sdk = yield* Sdk;
  const ui = yield* Ui;
  const store = yield* Store;
  const config = yield* RunConfig;
  const session = yield* Ref.make<string | null>(null);

  /**
   * The real location of a path that may not exist yet: its nearest existing ancestor resolved through
   * symlinks, plus the rest (finding 21). A path with no existing ancestor is returned as resolved.
   */
  const realLocation = async (target: string): Promise<string> => {
    let existing = target;
    const rest: string[] = [];
    for (;;) {
      try {
        return path.join(await fsp.realpath(existing), ...rest);
      } catch {
        const parent = path.dirname(existing);
        if (parent === existing) return target;
        rest.unshift(path.basename(existing));
        existing = parent;
      }
    }
  };
  /** True when the named target lies under plan-review/ on the file system, not only lexically. */
  const underRecords = async (named: string): Promise<boolean> => {
    const allowed = (await realLocation(store.dir)) + path.sep;
    return (await realLocation(path.resolve(store.project, named))).startsWith(allowed);
  };

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
  // permission evaluation, so the denial applies in every permission mode. An input without a
  // readable target is denied like one outside. The target is resolved on the file system, so a
  // symlink under plan-review/ that points outside is denied (finding 21). Race policy: the check
  // is made at hook time; the project snapshot comparison after the call is the second check
  // (behaviour 3), and the container is the boundary.
  const restrictEdits: HookCallback = async (input) => {
    const pre = input as PreToolUseHookInput;
    const named = decodeToolTarget(pre.tool_input);
    if (named !== null && (await underRecords(named))) return {};
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
  // The stop belongs to one execution call (finding 20): the hook and the permission closure of a
  // call share the Ref that `executing` created for it.
  const denyAfterStop =
    (stop: Ref.Ref<Stop | null>): HookCallback =>
    async (input) => {
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
        return inCallback(
          Effect.gen(function* () {
            const questions = yield* questionsOf(input);
            const answers = yield* sdkAnswers(questions, yield* relayQuestions(questions));
            return { behavior: "allow", updatedInput: { questions, answers } } as PermissionResult;
          }),
          deny("The question could not be relayed to the user."),
        );
      }
      if (EDIT_TOOLS.includes(toolName)) return { behavior: "allow", updatedInput: input };
      return deny("During a planning phase, only reading and writing under plan-review/ are permitted.");
    };

  const executionPermission =
    (stop: Ref.Ref<Stop | null>, inCallback: InCallback): CanUseTool =>
    async (toolName, input): Promise<PermissionResult> => {
      if (toolName === "AskUserQuestion") {
        await inCallback(
          Effect.gen(function* () {
            const questions = yield* questionsOf(input);
            yield* ui.say("\nClaude Code has stopped execution with a question.");
            const answers = yield* relayQuestions(questions);
            yield* Ref.set(stop, {
              question: questions.map((q) => q.question).join(" / "),
              input: [...answers].map(([index, a]) => `${questions[index].question} -> ${a}`).join("; "),
            });
          }),
          undefined,
        );
        return deny(
          "The user's answer is recorded in plan-review/user-decisions.md. Do not continue the implementation. Make no tool call other than the final structured output, and end your turn with status 'needs_input', a summary, and the remaining work. The plan will be revised and reviewed before work continues.",
        );
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
      return deny("The user denied this action.");
    };

  /**
   * One SDK call. The messages are consumed inside the Effect, so an interruption aborts the call
   * through the SDK's AbortController. A callback runs its Effects through the runtime; if one fails,
   * the first failure is kept in a typed Deferred (its exact `CallbackError` type, no cast at the
   * Promise boundary; finding 10), the call is aborted, and the call fails with it. A defect in a
   * callback still rejects the callback's Promise. The messages are shown and the usage recorded as
   * they arrive; the outcome is the pure reduction of the list at the end.
   */
  const call = (prompt: string, show: "none" | "tools" | "text", options: Options, permission: (inCallback: InCallback) => CanUseTool): Effect.Effect<CallOutcome, CallbackError> =>
    Effect.gen(function* () {
      const controller = new AbortController();
      const callbackFailure = yield* Deferred.make<never, CallbackError>();
      const inCallback: InCallback = (effect, fallback) =>
        Effect.runPromise(
          effect.pipe(
            Effect.catch((e: CallbackError) =>
              Deferred.fail(callbackFailure, e).pipe(
                Effect.andThen(Effect.sync(() => controller.abort())),
                Effect.as(fallback),
              ),
            ),
          ),
          { signal: controller.signal },
        );
      const full: Options = { ...options, cwd: store.project, abortController: controller, canUseTool: permission(inCallback) };
      const resumed = yield* Ref.get(session);
      if (resumed !== null) full.resume = resumed;
      if (config.claudeModel !== null) full.model = config.claudeModel;

      const failed = (e: unknown): string => (e instanceof Error ? e.message : String(e));
      // Starting the call can throw synchronously (for example when the SDK cannot start its CLI);
      // that is a call error like a failure of the stream, not a defect.
      const started = yield* Effect.try({ try: () => sdk.query({ prompt, options: full })[Symbol.asyncIterator](), catch: failed }).pipe(Effect.result);
      if (Result.isFailure(started)) return reduceMessages([], started.failure);
      const iterator = started.success;
      const seen: SDKMessage[] = [];
      let streamError: string | null = null;
      /** The next message, or null at the end; a failure of the stream ends the call with its text. */
      const next = (): Effect.Effect<SDKMessage | null> =>
        Effect.tryPromise({ try: () => iterator.next(), catch: (e: unknown) => e }).pipe(
          Effect.map((step) => (step.done ? null : step.value)),
          Effect.catch((e) =>
            Effect.sync(() => {
              streamError = failed(e);
              return null;
            }),
          ),
        );
      const consume = Effect.gen(function* () {
        for (let message = yield* next(); message !== null; message = yield* next()) {
          seen.push(message);
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
            yield* store.recordUsage({ agent: "claude", session: yield* Ref.get(session), turns: message.num_turns, totalCostUsd: message.total_cost_usd });
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
      if (yield* Deferred.isDone(callbackFailure)) return yield* Deferred.await(callbackFailure);
      return reduceMessages(seen, streamError);
    });

  return {
    planning: (prompt, schema, progress = false) =>
      Effect.gen(function* () {
        const outcome = yield* call(
          prompt,
          progress ? "tools" : "none",
          {
            permissionMode: "default",
            outputFormat: { type: "json_schema", schema: agentJsonSchema(schema) },
            hooks: { PreToolUse: [{ matcher: EDIT_TOOLS.join("|"), hooks: [restrictEdits] }] },
          },
          planningPermission,
        );
        if (outcome.error !== null) return yield* Effect.fail(new ClaudeCallFailed({ message: outcome.error }));
        return { output: outcome.structured, resultText: outcome.resultText, costUsd: outcome.costUsd };
      }),
    executing: (prompt) =>
      Effect.gen(function* () {
        const stop = yield* Ref.make<Stop | null>(null);
        const outcome = yield* call(
          prompt,
          "text",
          {
            permissionMode: config.execPermissionMode,
            outputFormat: { type: "json_schema", schema: agentJsonSchema(S.ExecReport) },
            hooks: { PreToolUse: [{ hooks: [denyAfterStop(stop)] }] },
          },
          (inCallback) => executionPermission(stop, inCallback),
        );
        return interpretExecution(outcome, yield* Ref.get(stop));
      }),
    sessionId: Ref.get(session),
  };
});

export const claudePlannerLayer: Layer.Layer<Planner, never, Sdk | Ui | Store | RunConfig> = Layer.effect(Planner, makeClaudePlanner);
