// The review procedure: Codex reviews a file in rounds, Claude Code answers each issue, and the
// rounds end when a review contains no counted issue or when the user chooses to proceed.
// The procedure is applied to three subjects: the question list, the requirements, and the plan.

import { Effect, Ref, Schema } from "effect";
import { type SubjectId, subjectDir } from "./artifacts.ts";
import { AgentReplyInvalid, ProjectChanged, RecordsChanged, ReviewedFileChanged, type RunError } from "./errors.ts";
import type { LoopResult } from "./uiEvents.ts";
import { decisionPrompt, limitNoProceedPrompt, limitPrompt, repairReplyPrompt, type RespondContext } from "./prompts.ts";
import { advance, initialState, type ReviewCommand, type ReviewEvent, type ReviewSetup, type ReviewState, type Transition } from "./reviewState.ts";
import * as S from "./schema.ts";
import type { PlannerResponse, Review } from "./schema.ts";
import { Planner, type PlanningCapability, type PlanningPurpose, type PlanningResult, Reviewer, RunConfig, type Services, Store, type StoreError, Ui } from "./services.ts";
import { compareRecords, compareSnapshots } from "./snapshot.ts";

/** Codex's reply text, decoded as JSON and then as a review; text that is not JSON is a decode failure. */
const ReviewText = Schema.fromJsonString(S.Review);

/** One planning call of a subject: its prompt, the schema of its output, and what is done with the output. */
export type Operation<T> = Readonly<{
  prompt: (round: number, context: RespondContext) => string;
  schema: Schema.Decoder<T>;
  /** Runs after every such call, for output that the program writes to the file; null when there is nothing to do. */
  after: ((output: T) => Effect.Effect<void, RunError, Store>) | null;
  /** What the call may do (finding 1 of docs/gui-review.md): "readOnly" for a work response, "records" otherwise. */
  capability: PlanningCapability;
}>;

/** What the review procedure is applied to. `R` is the response to a review, `D` the output of applying decisions (finding 12). */
export type Subject<R extends PlannerResponse = PlannerResponse, D = unknown> = Readonly<{
  /** The subject's identity: its files, phase and directory come from src/artifacts.ts. */
  id: SubjectId;
  /** The phase its loop records in log entries, round records and checkpoints: a decision's is the phase in which it took place. */
  phase: number;
  /** Heading in conversation.md and in terminal output, for example "Planning phase 2". */
  heading: string;
  /** Name of the reviewed file as used in messages, for example "plan.md". */
  fileLabel: string;
  reviewPrompt: (round: number) => string;
  /** Claude Code's response to a review. */
  respond: Operation<R>;
  /** The call that applies the user's decisions; its prompt does not depend on the round. */
  applyDecisions: Readonly<{ prompt: string; schema: Schema.Decoder<D>; after: ((output: D) => Effect.Effect<void, RunError, Store>) | null }>;
  /** After the response of a round, an amendment that requires the user (the requirements); null otherwise. */
  amend: ((review: Review, response: R, round: number) => Effect.Effect<void, RunError, Services>) | null;
  /** Text of the "p" choice at the round limit; null: no such choice (the work review, Q13). */
  proceed: string | null;
  /** Q14: a round with a correction due ends the loop with "revise" before the observation. */
  leaveOnAcceptance: boolean;
  /** G-R1-1: a non-empty decision at a pause ends the loop with "revise" instead of a planning call. */
  leaveOnDecision: boolean;
  /** Run before every round's Codex turn, before its guard's snapshot (the work review rewrites changes.diff); null otherwise. */
  prepare: Effect.Effect<void, RunError, Services> | null;
}>;

/** Reads one decision outside a review loop (a question of the plan writer). An empty answer records nothing and returns "". */
export const askDecision = (subject: string, phase: number, round: number): Effect.Effect<string, RunError, Ui | Store> =>
  Effect.gen(function* () {
    const ui = yield* Ui;
    const store = yield* Store;
    const decision = yield* ui.ask(decisionPrompt(subject));
    if (decision !== "") yield* store.appendDecision({ subject, id: null, decision, phase, round });
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

/**
 * A call in which Claude Code may write only under plan-review/ ("records"), or change nothing ("readOnly", a work
 * response). Halts if the project changed; a read-only call, its repair turn included, also halts if a guarded record
 * under plan-review/ changed (RecordsChanged; the program's own writes are not guarded, src/artifacts.ts).
 */
export const planningCall = <Out extends Schema.Decoder<unknown>>(prompt: string, schema: Out, purpose: PlanningPurpose = "planning", capability: PlanningCapability = "records"): Effect.Effect<PlanningCall<Out["Type"]>, RunError, Store | Planner> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const planner = yield* Planner;
    const call = (text: string) =>
      Effect.gen(function* () {
        const before = yield* store.projectSnapshot();
        const recordsBefore = capability === "readOnly" ? yield* store.recordsSnapshot() : null;
        const result = yield* planner.planning(text, schema, purpose, capability);
        const changes = compareSnapshots(before, yield* store.projectSnapshot());
        if (changes.length > 0) return yield* Effect.fail(new ProjectChanged({ during: "planning", fileLabel: null, changes }));
        if (recordsBefore !== null) {
          const records = compareRecords(recordsBefore, yield* store.recordsSnapshot());
          if (records.length > 0) return yield* Effect.fail(new RecordsChanged({ changes: records }));
        }
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
/** How a review loop ended, and in which round. */
export type LoopEnd = Readonly<{ result: LoopResult; round: number }>;

export const reviewLoop = <R extends PlannerResponse, D>(subject: Subject<R, D>): Effect.Effect<LoopEnd, RunError, Services> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const ui = yield* Ui;
    const config = yield* RunConfig;
    const reviewer = yield* Reviewer;
    const { id, heading, fileLabel } = subject;
    const phase = subject.phase;
    // One thread per review loop (behaviour 5): the session is held by this loop, not by the adapter.
    const session = yield* reviewer.startPhase;

    // Codex runs without a sandbox, so the project and the reviewed file are compared after every turn,
    // including a repair turn.
    const reviewCall = (text: string) =>
      Effect.gen(function* () {
        const projectBefore = yield* store.projectSnapshot();
        const fileBefore = yield* store.fileHash(id);
        // The bytes of the reviewed artifact too: a work review's fileHash is recomputed from the project and
        // does not see an edit of changes.diff itself (P1-R2-2).
        const recordBefore = yield* store.recordHash(id);
        const reply = yield* session.review(text);
        const changes = compareSnapshots(projectBefore, yield* store.projectSnapshot());
        // The artifact's bytes, or the observed hash without a visible project change (a work review's diff also
        // changes with a commit); a change of the project itself is reported as ProjectChanged below. For the
        // other subjects both hashes are the file's content, as before.
        const recordChanged = (yield* store.recordHash(id)) !== recordBefore;
        const fileChanged = recordChanged || ((yield* store.fileHash(id)) !== fileBefore && changes.length === 0);
        if (fileChanged) return yield* Effect.fail(new ReviewedFileChanged({ fileLabel, changes: [...changes, { kind: "content_changed", path: fileLabel }] }));
        if (changes.length > 0) return yield* Effect.fail(new ProjectChanged({ during: "review", fileLabel, changes }));
        return reply;
      });

    type Outcome = ReviewEvent | { finished: LoopResult };
    /** Executes one command; the commands that yield an event return it. */
    const execute = (command: ReviewCommand, state: ReviewState): Effect.Effect<Outcome | null, RunError, Services> =>
      Effect.gen(function* () {
        switch (command.kind) {
          case "Say":
            yield* ui.say(command.text);
            return null;
          case "Notify":
            yield* ui.notify(command.event);
            return null;
          case "Converse":
            yield* store.converse(command.markdown);
            return null;
          case "RecordDecision":
            yield* store.appendDecision(command.decision);
            return null;
          case "RecordFeedback":
            yield* store.recordFeedback(id, command.round, command.text);
            return null;
          case "SaveReview":
            yield* store.saveReview(id, command.round, command.review);
            return null;
          case "SaveResponse":
            yield* store.saveResponse(id, command.round, command.response);
            if (subject.respond.after !== null) yield* subject.respond.after(command.response as R);
            return null;
          case "SaveLog":
            yield* store.saveLog(id, command.log);
            return null;
          case "SaveRound":
            yield* store.saveRound(id, command.record);
            return null;
          case "Checkpoint":
            yield* store.checkpoint(command.point);
            return null;
          case "Halt":
            return yield* Effect.fail(command.error);
          case "Finish":
            return { finished: command.result };
          case "AskLimit":
            return { kind: "LimitAnswer", answer: yield* ui.ask(state.setup.proceed === null ? limitNoProceedPrompt(command.limit) : limitPrompt(command.limit, state.setup.proceed)) };
          case "AskDecision":
            return { kind: "DecisionGiven", text: yield* ui.ask(decisionPrompt(command.subject)) };
          case "CallReviewer": {
            // Before the turn's guard takes its snapshot, so that it is not counted as a change during the turn.
            if (subject.prepare !== null) yield* subject.prepare;
            const review: Review = yield* decodeWithRepair("codex", ReviewText, yield* reviewCall(subject.reviewPrompt(command.round)), reviewCall);
            return { kind: "ReviewDecoded", review };
          }
          case "CallPlanner": {
            // A read-only response cannot read the records, so they are in its prompt (decision Q1 of the stage-A task).
            const changes = typeof id === "object" && "work" in id && subject.respond.capability === "readOnly" ? yield* store.readChangeRecord(id.work) : null;
            const context: RespondContext = { review: state.current.review!, log: state.log, changes };
            const call = yield* planningCall(subject.respond.prompt(command.round, context), subject.respond.schema, "planning", subject.respond.capability);
            return { kind: "ResponseDecoded", response: call.output, resultText: call.resultText, costUsd: call.costUsd };
          }
          case "ApplyDecisions":
            yield* applyDecisions(subject as Subject<PlannerResponse, D>);
            return { kind: "DecisionsApplied" };
          case "Amend":
            if (subject.amend !== null) yield* subject.amend(state.current.review!, state.current.response as R, command.round);
            return { kind: "Amended" };
          case "ObserveFile":
            return { kind: "FileObserved", hash: yield* store.fileHash(id) };
        }
      });

    const interpret = (transition: Transition): Effect.Effect<LoopEnd, RunError, Services> =>
      Effect.gen(function* () {
        for (const command of transition.commands) {
          const outcome = yield* execute(command, transition.state);
          if (outcome === null) continue;
          if ("finished" in outcome) return { result: outcome.finished, round: transition.state.round };
          return yield* interpret(advance(transition.state, outcome));
        }
        return yield* Effect.die(new Error("the review loop ended a batch without an event"));
      });

    const setup: ReviewSetup = { subject: id, heading, fileLabel, dirName: subjectDir(id), phase, idNumber: typeof id === "object" && "decision" in id ? id.decision : phase, proceed: subject.proceed, hasAmend: subject.amend !== null, leaveOnAcceptance: subject.leaveOnAcceptance, leaveOnDecision: subject.leaveOnDecision, maxRounds: config.maxRounds, maxIdleRounds: config.maxIdleRounds, countMinor: config.countMinor };
    return yield* interpret(advance(initialState(setup, config), { kind: "Begin", hash: yield* store.fileHash(id), log: yield* store.loadLog(id) }));
  });
