// The review procedure: Codex reviews a file in rounds, Claude Code answers each issue, and the
// rounds end when a review contains no counted issue or when the user chooses to proceed.
// The procedure is applied to three subjects: the question list, the requirements, and the plan.

import { Effect, Ref, Schema } from "effect";
import * as path from "node:path";
import { AgentReplyInvalid, ProjectChanged, ReviewedFileChanged, type RunError } from "./errors.ts";
import { repairReplyPrompt } from "./prompts.ts";
import { VERSION } from "./records.ts";
import { advance, initialState, type ReviewCommand, type ReviewEvent, type ReviewSetup, type ReviewState, type Transition } from "./reviewState.ts";
import * as S from "./schema.ts";
import type { PlannerResponse, Review } from "./schema.ts";
import { Planner, type PlanningResult, Reviewer, RunConfig, type Services, Store, type StoreError, Ui } from "./services.ts";
import { compareSnapshots } from "./snapshot.ts";

/** Codex's reply text, decoded as JSON and then as a review; text that is not JSON is a decode failure. */
const ReviewText = Schema.fromJsonString(S.Review);

/** One planning call of a subject: its prompt, the schema of its output, and what is done with the output. */
export type Operation<T> = Readonly<{
  prompt: (round: number) => string;
  schema: Schema.Decoder<T>;
  /** Runs after every such call, for output that the program writes to the file; null when there is nothing to do. */
  after: ((output: T) => Effect.Effect<void, RunError>) | null;
}>;

/** What the review procedure is applied to. `R` is the response to a review, `D` the output of applying decisions (finding 12). */
export type Subject<R extends PlannerResponse = PlannerResponse, D = unknown> = Readonly<{
  /** Heading in conversation.md and in terminal output, for example "Planning phase 2". */
  heading: string;
  /** Name of the reviewed file as used in messages, for example "plan.md". */
  fileLabel: string;
  /** Absolute path of the reviewed file. */
  file: string;
  /** File name of the issue log of this subject. */
  logName: string;
  /** Subdirectory of plan-review/ for the JSON files of the rounds. */
  dirName: string;
  /** Number recorded in the phase field of log entries. */
  phase: number;
  reviewPrompt: (round: number) => string;
  /** Claude Code's response to a review. */
  respond: Operation<R>;
  /** The call that applies the user's decisions; its prompt does not depend on the round. */
  applyDecisions: Readonly<{ prompt: string; schema: Schema.Decoder<D>; after: ((output: D) => Effect.Effect<void, RunError>) | null }>;
  /** After the response of a round, an amendment that requires the user (the requirements); null otherwise. */
  amend: ((review: Review, response: R, round: number) => Effect.Effect<void, RunError, Services>) | null;
  /** Text of the "p" choice at the round limit. */
  proceedLabel: string;
}>;

/** Reads one decision. An empty answer records nothing and returns "". */
export const askDecision = (subject: string): Effect.Effect<string, RunError, Ui | Store> =>
  Effect.gen(function* () {
    const ui = yield* Ui;
    const store = yield* Store;
    const decision = yield* ui.ask(`Decision on: ${subject} (Enter = none, q = quit) > `);
    if (decision !== "") yield* store.recordDecision(subject, decision);
    return decision;
  });

const AGENT_LABEL = { claude: "Claude Code", codex: "Codex" } as const;

/** The text kept for an invalid reply. Total: a reply that JSON cannot represent is kept as a note of that failure. */
export const serializeReply = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch (e) {
    return `<reply not serializable: ${e instanceof Error ? e.message : String(e)}>`;
  }
};

/**
 * Decodes an agent's reply with its schema. A reply that does not match is kept on disk and the agent
 * gets one repair turn in the same session or thread; a second mismatch fails with AgentReplyInvalid.
 * Excess properties are ignored: they break no assumption of the program.
 */
export const decodeWithRepair = <Out extends Schema.Decoder<unknown>, E, R>(
  agent: keyof typeof AGENT_LABEL,
  schema: Out,
  reply: unknown,
  repair: (prompt: string) => Effect.Effect<unknown, E, R>,
): Effect.Effect<Out["Type"], E | AgentReplyInvalid | StoreError, R | Store> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const decode = (value: unknown): { ok: true; value: Out["Type"] } | { ok: false; issue: string } => {
      try {
        return { ok: true, value: Schema.decodeUnknownSync(schema, { errors: "all" })(value) };
      } catch (e) {
        if (Schema.isSchemaError(e)) return { ok: false, issue: e.message };
        throw e;
      }
    };
    const keep = (value: unknown): Effect.Effect<string, StoreError> => store.saveInvalidReply(agent, serializeReply(value));

    const first = decode(reply);
    if (first.ok) return first.value;
    const firstFile = yield* keep(reply);
    const secondReply = yield* repair(repairReplyPrompt(first.issue));
    const second = decode(secondReply);
    if (second.ok) return second.value;
    const secondFile = yield* keep(secondReply);
    return yield* Effect.fail(new AgentReplyInvalid({ agent: AGENT_LABEL[agent], issue: second.issue, files: [firstFile, secondFile] }));
  });

/** The decoded output of a planning call, the free text and cost of the call that produced it, and whether a repair turn was needed. */
export type PlanningCall<Out> = Readonly<{ output: Out; resultText: string; costUsd: number | null; repaired: boolean }>;

/** A call in which Claude Code may write only under plan-review/. Halts if the project changed. */
export const planningCall = <Out extends Schema.Decoder<unknown>>(prompt: string, schema: Out, progress = false): Effect.Effect<PlanningCall<Out["Type"]>, RunError, Store | Planner> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const planner = yield* Planner;
    const call = (text: string) =>
      Effect.gen(function* () {
        const before = yield* store.projectSnapshot();
        const result = yield* planner.planning(text, schema, progress);
        const changes = compareSnapshots(before, yield* store.projectSnapshot());
        if (changes.length > 0) return yield* Effect.fail(new ProjectChanged({ during: "planning", fileLabel: null, changes }));
        return result;
      });
    const first = yield* call(prompt);
    const repairCall = yield* Ref.make<PlanningResult | null>(null);
    const repair = (text: string) => call(text).pipe(Effect.tap((result) => Ref.set(repairCall, result)), Effect.map((result) => result.output));
    const output = yield* decodeWithRepair("claude", schema, first.output, repair);
    const second = yield* Ref.get(repairCall);
    const used = second ?? first;
    return { output, resultText: used.resultText, costUsd: used.costUsd, repaired: second !== null };
  });

export const applyDecisions = <D>(subject: Subject<PlannerResponse, D>): Effect.Effect<void, RunError, Services> =>
  Effect.gen(function* () {
    const call = yield* planningCall(subject.applyDecisions.prompt, subject.applyDecisions.schema);
    if (subject.applyDecisions.after !== null) yield* subject.applyDecisions.after(call.output);
  });

/**
 * The review procedure, as the interpreter of src/reviewState.ts: every command of a transition is executed
 * against the services, and the command that yields an event (the last of its batch) drives the next
 * transition. The pauses, the log update and the progress checks are all in `advance`.
 */
export const reviewLoop = <R extends PlannerResponse, D>(subject: Subject<R, D>): Effect.Effect<"converged" | "proceed", RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    const config = yield* RunConfig;
    const reviewer = yield* Reviewer;
    const { heading, fileLabel, file, logName, phase } = subject;
    const dir = yield* store.subDir(subject.dirName);
    // One thread per review loop (behaviour 5): the session is held by this loop, not by the adapter.
    const session = yield* reviewer.startPhase;

    // Codex runs without a sandbox, so the project and the reviewed file are compared after every turn,
    // including a repair turn.
    const reviewCall = (text: string) =>
      Effect.gen(function* () {
        const projectBefore = yield* store.projectSnapshot();
        const fileBefore = yield* store.fileHash(file);
        const reply = yield* session.review(text);
        const changes = compareSnapshots(projectBefore, yield* store.projectSnapshot());
        const fileChanged = (yield* store.fileHash(file)) !== fileBefore;
        if (fileChanged) return yield* Effect.fail(new ReviewedFileChanged({ fileLabel, changes: [...changes, { kind: "content_changed", path: fileLabel }] }));
        if (changes.length > 0) return yield* Effect.fail(new ProjectChanged({ during: "review", fileLabel, changes }));
        return reply;
      });

    type Outcome = ReviewEvent | { finished: "converged" | "proceed" };
    /** Executes one command; the commands that yield an event return it. */
    const execute = (command: ReviewCommand, state: ReviewState): Effect.Effect<Outcome | null, RunError, Services> =>
      Effect.gen(function* () {
        switch (command.kind) {
          case "Say":
            yield* ui.say(command.text);
            return null;
          case "Converse":
            yield* store.converse(command.markdown);
            return null;
          case "RecordDecision":
            yield* store.recordDecision(command.decision.subject, command.decision.decision);
            return null;
          case "RecordFeedback":
            yield* store.recordFeedback(heading, command.round, command.text);
            return null;
          case "SaveReview":
            yield* store.writeJson(path.join(dir, `review-${command.round}.json`), command.review);
            return null;
          case "SaveResponse":
            yield* store.writeJson(path.join(dir, `cc-${command.round}.json`), command.response);
            if (subject.respond.after !== null) yield* subject.respond.after(command.response as R);
            return null;
          case "SaveLog":
            yield* store.saveLog(logName, command.log);
            return null;
          case "SaveRound":
            yield* store.writeJson(path.join(dir, `round-${command.record.round}.json`), { version: VERSION, ...command.record });
            return null;
          case "Halt":
            return yield* Effect.fail(command.error);
          case "Finish":
            return { finished: command.result };
          case "AskLimit":
            return { kind: "LimitAnswer", answer: yield* ui.ask(`${command.limit} rounds completed without convergence. Number = additional rounds; p = ${subject.proceedLabel}; 0 = stop > `) };
          case "AskDecision":
            return { kind: "DecisionGiven", text: yield* ui.ask(`Decision on: ${command.subject} (Enter = none, q = quit) > `) };
          case "CallReviewer": {
            const review: Review = yield* decodeWithRepair("codex", ReviewText, yield* reviewCall(subject.reviewPrompt(command.round)), reviewCall);
            return { kind: "ReviewDecoded", review };
          }
          case "CallPlanner": {
            const call = yield* planningCall(subject.respond.prompt(command.round), subject.respond.schema);
            return { kind: "ResponseDecoded", response: call.output, resultText: call.resultText, costUsd: call.costUsd };
          }
          case "ApplyDecisions":
            yield* applyDecisions(subject as Subject<PlannerResponse, D>);
            return { kind: "DecisionsApplied" };
          case "Amend":
            if (subject.amend !== null) yield* subject.amend(state.current.review!, state.current.response as R, command.round);
            return { kind: "Amended" };
          case "ObserveFile":
            return { kind: "FileObserved", hash: yield* store.fileHash(file) };
        }
      });

    const interpret = (transition: Transition): Effect.Effect<"converged" | "proceed", RunError, Services> =>
      Effect.gen(function* () {
        for (const command of transition.commands) {
          const outcome = yield* execute(command, transition.state);
          if (outcome === null) continue;
          if ("finished" in outcome) return outcome.finished;
          return yield* interpret(advance(transition.state, outcome));
        }
        return yield* Effect.die(new Error("the review loop ended a batch without an event"));
      });

    const setup: ReviewSetup = { heading, fileLabel, dirName: subject.dirName, phase, proceedLabel: subject.proceedLabel, hasAmend: subject.amend !== null, maxRounds: config.maxRounds, maxIdleRounds: config.maxIdleRounds, countMinor: config.countMinor };
    return yield* interpret(advance(initialState(setup, config), { kind: "Begin", hash: yield* store.fileHash(file), log: yield* store.loadLog(logName) }));
  });
