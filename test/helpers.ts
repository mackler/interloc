import assert from "node:assert/strict";
import type { UiEvent } from "../src/uiEvents.ts";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after } from "node:test";
import { Cause, Effect, Exit, FileSystem, Layer, Option, PlatformError } from "effect";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import type { Schema } from "effect";
import type { RunError } from "../src/errors.ts";
import { describe, UserStopped } from "../src/errors.ts";
import { parseAskLine, parseMessage } from "../src/input.ts";
import type { Wiring } from "../src/program.ts";
import type { SubjectId } from "../src/artifacts.ts";
import { run } from "../src/run.ts";
import * as S from "../src/schema.ts";
import type { Plan as SPlan, RecordedPlan, StepStatus } from "../src/schema.ts";
import { type DeciderShape, Planner, type PlannerShape, type PlanningCapability, type PlanningPurpose, Reviewer, type ReviewerShape, type ReviewSession, RunConfig, type Services, type StepReply, type StepReporter, Store, type StoreShape, Ui, type UiShape } from "../src/services.ts";
import { type Platform, platformLayer } from "../src/platform.ts";
import { makeStore, storeLayer } from "../src/store.ts";
import { type DeciderDeps, deciderLayer } from "../src/decision.ts";
import { FakeSdk } from "./fakeSdk.ts";

type Config = typeof S.Config.Type;
type ExecOutcome = typeof S.ExecOutcome.Type;
type PlannerResponse = typeof S.PlannerResponse.Type;
type Review = typeof S.Review.Type;
type LogEntry = typeof S.LogEntry.Type;
const { defaultConfig } = S;

/** The paths a scripted agent writes to. */
export type Paths = { readonly project: string; readonly plan: string; readonly planFile: string };
export const pathsOf = (repo: string): Paths => ({ project: path.resolve(repo), plan: path.join(repo, "plan-review", "plan.md"), planFile: path.join(repo, "plan-review", "plan.json") });

/** The plan a scripted step stands for (issue #6, F1): one stage with one step S1 whose text is the step's `plan`. */
export const scriptedPlan = (text: string): SPlan => ({ stages: [{ number: 1, title: "Plan", steps: [{ id: "S1", number: 1, label: "Step", text }] }] });
/** That plan as plan.json records it, every step with `status`. */
export const scriptedRecordedPlan = (text: string, status: StepStatus = "pending"): RecordedPlan => ({ stages: scriptedPlan(text).stages.map((st) => ({ ...st, steps: st.steps.map((x) => ({ ...x, status })) })) });
/** Whether a planning call's schema carries the plan (the plan write and the response to a plan review). */
const carriesPlan = (schema: Schema.Top): boolean => schema === S.PlanWrite || schema === S.PlanResponse;

/** Every temporary directory a test file created; removed when the file's tests are done. */
const tempDirs: string[] = [];
export const tempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

export function tempRepo(): string {
  const dir = tempDir("pr-test-");
  const git = (...args: string[]): void => void execFileSync("git", ["-C", dir, ...args]);
  git("init", "-q");
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  git("add", "a.txt");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return dir;
}

/** One scripted answer: the text the user types, or a step that never completes (for interruption tests). */
export type ScriptedAnswer = string | { readonly wait: true };

/** A promise that resolves when `signal` is next called; for tests that wait for a double to be reached. */
const readiness = (): { wait: () => Promise<void>; signal: () => void } => {
  let waiters: (() => void)[] = [];
  return {
    wait: () => new Promise((resolve) => waiters.push(resolve)),
    signal: () => {
      const current = waiters;
      waiters = [];
      for (const resolve of current) resolve();
    },
  };
};

export class ScriptedUi implements UiShape {
  readonly said: string[] = [];
  readonly asked: string[] = [];
  readonly notified: UiEvent[] = [];
  private readonly answers: ScriptedAnswer[];
  private readonly asks = readiness();
  constructor(answers: readonly ScriptedAnswer[]) {
    this.answers = [...answers];
  }
  /** Resolves when the next prompt is asked. */
  nextAsk(): Promise<void> {
    return this.asks.wait();
  }
  notify(event: UiEvent): Effect.Effect<void> {
    return Effect.sync(() => void this.notified.push(event));
  }
  say(text: string): Effect.Effect<void> {
    return Effect.sync(() => void this.said.push(text));
  }
  /** The commands are the terminal's (src/input.ts): "q" ends the run at a one-line prompt. */
  ask(prompt: string): Effect.Effect<string, UserStopped> {
    return this.take(prompt, (text) => {
      const parsed = parseAskLine(text);
      return parsed.kind === "quit" ? Effect.fail(new UserStopped({ where: prompt })) : Effect.succeed(parsed.text);
    });
  }
  /** "/quit" ends the run in a message; "q" is a message like any other. */
  askMessage(prompt: string): Effect.Effect<string, UserStopped> {
    return this.take(prompt, (text) => {
      const parsed = parseMessage(text);
      return parsed.kind === "quit" ? Effect.fail(new UserStopped({ where: prompt })) : Effect.succeed(parsed.text);
    });
  }
  private take(prompt: string, interpret: (text: string) => Effect.Effect<string, UserStopped>): Effect.Effect<string, UserStopped> {
    return Effect.suspend(() => {
      this.asked.push(prompt);
      this.asks.signal();
      const answer = this.answers.shift();
      if (answer === undefined) return Effect.die(new Error(`no scripted answer for: ${prompt}`));
      if (typeof answer !== "string") return Effect.never;
      return interpret(answer);
    });
  }
}

/** `hang` makes the call wait until it is interrupted, recording the abort signal it was given. */
/** `onCall` runs when the call begins, before anything else (a test captures the state the call finds). */
/**
 * `editRecord` writes a file under plan-review/ during the call, as an agent that bypassed the hook could (stage A's
 * detection tests); `usage` appends a line to usage.jsonl during the call, as the adapter does.
 */
export type PlanningStep = { output?: unknown; /** The text of the plan's one step (issue #6): a call whose schema carries the plan returns it as data. */ plan?: string; touchProject?: boolean; hang?: boolean; resultText?: string; onCall?: () => void; editRecord?: { file: string; content: string | null }; usage?: boolean };

/** What one scripted execution does besides its outcome (issue #6): report_step calls, and hooks around them. */
export type ExecScript = { reports?: readonly (readonly [string, "started" | "done"])[]; onCall?: () => void; after?: () => void; hang?: boolean };

export class ScriptedPlanner implements PlannerShape {
  readonly prompts: string[] = [];
  /** The Effect schema of each planning call, in order. */
  readonly schemas: Schema.Top[] = [];
  /** The capability of each planning call, in order. */
  readonly capabilities: PlanningCapability[] = [];
  /** The abort signals of the calls that hang. */
  readonly hangSignals: AbortSignal[] = [];
  private readonly hangs = readiness();
  /** Resolves when the next hanging call begins. */
  nextHang(): Promise<void> {
    return this.hangs.wait();
  }
  private readonly state: Paths;
  private readonly steps: PlanningStep[];
  private readonly execs: ExecOutcome[];
  private readonly execScripts: ExecScript[];
  constructor(state: Paths, steps: PlanningStep[], execs: ExecOutcome[], execScripts: readonly ExecScript[] = []) {
    this.state = state;
    this.steps = [...steps];
    this.execs = [...execs];
    this.execScripts = [...execScripts];
  }
  readonly sessionId = Effect.succeed("test-session");
  /** How often a fresh session was started (a decision loop); the fresh planner shares this script. */
  freshSessions = 0;
  readonly fresh: Effect.Effect<PlannerShape> = Effect.sync(() => {
    this.freshSessions++;
    return this;
  });
  /** Returns the scripted output as it is: the caller decodes it, as with the real agent. */
  planning(prompt: string, schema: Schema.Top, _purpose?: PlanningPurpose, capability: PlanningCapability = "records"): Effect.Effect<{ output: unknown; resultText: string; costUsd: number | null }> {
    return Effect.suspend(() => {
      this.prompts.push(prompt);
      this.schemas.push(schema);
      this.capabilities.push(capability);
      const step = this.steps.shift();
      if (!step) return Effect.die(new Error(`no scripted planning step for: ${prompt.slice(0, 60)}`));
      step.onCall?.();
      if (step.hang) {
        return Effect.callback((_resume, signal) => {
          this.hangSignals.push(signal);
          this.hangs.signal();
        });
      }
      if (step.touchProject) fs.appendFileSync(path.join(this.state.project, "a.txt"), "changed\n");
      const records = path.dirname(this.state.plan);
      if (step.editRecord !== undefined) {
        const file = path.join(records, step.editRecord.file);
        if (step.editRecord.content === null) fs.rmSync(file, { force: true });
        else {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, step.editRecord.content);
        }
      }
      if (step.usage) fs.appendFileSync(path.join(records, "usage.jsonl"), JSON.stringify({ version: 2, agent: "claude", session: "test-session", num_turns: 1, total_cost_usd: 0.1 }) + "\n");
      return Effect.succeed({ output: this.withPlan(schema, step), resultText: step.resultText ?? "", costUsd: 0.1 });
    });
  }
  /** The text of the last plan scripted, which a reply without `plan` returns unchanged (issue #6, F1). */
  private lastPlan: string | null = null;
  /**
   * A call whose schema carries the plan returns it as data (F1): `plan` scripts its one step's text, and without it the
   * last plan is returned unchanged, as an agent that leaves the plan as it is. An output that has `plan` keeps its own.
   */
  private withPlan(schema: Schema.Top, step: PlanningStep): unknown {
    if (step.plan !== undefined) this.lastPlan = step.plan;
    const output = step.output;
    if (!carriesPlan(schema) || output === null || typeof output !== "object" || Array.isArray(output) || "plan" in output || this.lastPlan === null) return output;
    return { ...output, plan: scriptedPlan(this.lastPlan) };
  }
  /** The replies of report_step to the scripted reports, in order (issue #6, Q2). */
  readonly stepReplies: StepReply[] = [];
  /**
   * An execution: the scripted reports of its ExecScript go to the phase's reporter in order, then `after` runs, then
   * the call hangs until interrupted when `hang` is set, or returns the scripted outcome.
   */
  /** The Ui an execution call reports its start and end to, as the adapter does; set by testWiring's agents layer. */
  callUi: UiShape | null = null;
  executing(_prompt: string, reporter: StepReporter): Effect.Effect<ExecOutcome, RunError> {
    const script = this.execScripts.shift() ?? {};
    const self = this;
    const ui = this.callUi;
    const body = Effect.gen(function* () {
      script.onCall?.();
      for (const [id, status] of script.reports ?? []) self.stepReplies.push(yield* reporter(id, status));
      script.after?.();
      if (script.hang) return yield* Effect.never;
      const outcome = self.execs.shift();
      if (!outcome) return yield* Effect.die(new Error("no scripted execution outcome"));
      fs.appendFileSync(path.join(self.state.project, "a.txt"), "implemented\n");
      return outcome;
    });
    if (ui === null) return body;
    return ui.notify({ _tag: "AgentCallStarted", agent: "claude", purpose: "execution" }).pipe(
      Effect.andThen(body),
      Effect.onExit((exit) => ui.notify({ _tag: "AgentCallEnded", agent: "claude", ok: Exit.isSuccess(exit) })),
    );
  }
}

/**
 * A scripted review. `plan` makes the reviewer change plan.json, the plan's reviewed file, during its turn, as Codex could.
 * `raw` replaces the reply text, for a reply that is not a review (or not JSON).
 */
export type ReviewStep = Review & { plan?: string; raw?: string; touchProject?: boolean; editRecord?: string; onCall?: () => void };

export class ScriptedReviewer implements ReviewerShape {
  phases = 0;
  readonly prompts: string[] = [];
  /** The phase number at each review call, so that a test can see that two calls shared a thread. */
  readonly callPhases: number[] = [];
  private readonly state: Paths;
  private readonly reviews: ReviewStep[];
  constructor(state: Paths, reviews: ReviewStep[]) {
    this.state = state;
    this.reviews = [...reviews];
  }
  /** Each start is a new "thread": the session remembers its phase number so that a test can see which calls shared one. */
  readonly startPhase: Effect.Effect<ReviewSession> = Effect.sync(() => {
    const phase = ++this.phases;
    return {
      /** Returns the reply text as Codex would: the caller decodes it. */
      review: (prompt: string): Effect.Effect<string> =>
        Effect.sync(() => {
          this.prompts.push(prompt);
          this.callPhases.push(phase);
          const step = this.reviews.shift();
          if (!step) throw new Error("no scripted review");
          step.onCall?.();
          if (step.plan !== undefined) fs.writeFileSync(this.state.planFile, step.plan);
          if (step.touchProject) fs.appendFileSync(path.join(this.state.project, "a.txt"), "codex\n");
          // A record under plan-review/ that the turn edits, as Codex could (the work review's changes.diff).
          if (step.editRecord !== undefined) fs.appendFileSync(path.join(this.state.project, "plan-review", step.editRecord), "edited by the reviewer\n");
          return step.raw ?? JSON.stringify({ issues: step.issues });
        }),
    };
  });
}

export const issue = (id: string, problem = "p"): Review["issues"][number] => ({ id, severity: "major", location: "s", problem, evidence: "e" });

export const respond = (dispositions: [string, PlannerResponse["dispositions"][number]["action"]][], extra: Partial<PlannerResponse> = {}): PlannerResponse => ({
  dispositions: dispositions.map(([id, action]) => ({ id, action, rationale: `rationale ${id}`, duplicate_of: "", reverses: "" })),
  self_corrections: [],
  reviewer_feedback: "",
  questions_for_user: [],
  ...extra,
});

export const finished: ExecOutcome = { status: "finished", summary: "done", question: "", remainingWork: "", userInput: null };

/** `store` wraps the live store of the test layer (a test that changes the project between the agents' calls). */
export type TestOptions = { answers?: readonly ScriptedAnswer[]; steps?: PlanningStep[]; reviews?: ReviewStep[]; execs?: ExecOutcome[]; execScripts?: readonly ExecScript[]; config?: Partial<Config>; platform?: Layer.Layer<Platform>; store?: (store: StoreShape) => StoreShape };

/**
 * The live platform with a file system whose writes and renames can fail: `shouldFail(method, count)` is asked
 * before the count-th write or rename (1-based), and a true answer fails it with a PlatformError (step 5.4).
 */
export const faultyPlatform = (shouldFail: (method: "writeFile" | "rename", count: number) => boolean): Layer.Layer<Platform> => {
  let count = 0;
  const injected = (method: string) => new PlatformError.PlatformError(new PlatformError.SystemError({ _tag: "Unknown", module: "FileSystem", method, description: "injected write failure" }));
  const faulty = Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const live = yield* FileSystem.FileSystem;
      const gate = <A>(method: "writeFile" | "rename", effect: Effect.Effect<A, PlatformError.PlatformError>): Effect.Effect<A, PlatformError.PlatformError> =>
        Effect.suspend(() => (shouldFail(method, ++count) ? Effect.fail(injected(method)) : effect));
      return FileSystem.make({ ...live, writeFile: (p, data, options) => gate("writeFile", live.writeFile(p, data, options)), rename: (from, to) => gate("rename", live.rename(from, to)) });
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer));
  return Layer.provideMerge(NodeChildProcessSpawner.layer, Layer.mergeAll(faulty, NodePath.layer));
};
/** What a test inspects after a run: the scripted implementations, the paths, and a reader of the logs on disk. */
export type Probe = {
  dir: string;
  plan: string;
  requirements: string;
  loadLog: (subject?: SubjectId) => Promise<readonly LogEntry[]>;
  ui: ScriptedUi;
  planner: ScriptedPlanner;
  reviewer: ScriptedReviewer;
  config: Config;
};

/** The developer's format of the representation (docs/decision-making.md), as the program reads it. */
export const DECISION_FORMAT_TEXT = fs.readFileSync(new URL("../docs/decision-making.md", import.meta.url), "utf8");
/** A reporter for execution calls that expect no report_step call: a call is a defect. */
export const noReporter: StepReporter = (id) => Effect.die(new Error(`no report of a step was expected: ${id}`));
/** A Decider for tests that expect no decision: a call is a defect. */
export const noDecider: DeciderShape = { at: () => noDecider, decide: () => Effect.die(new Error("no decision was expected")) };
/** The services with the Decider built over them (decision support, D3), as src/program.ts builds it. */
export const withDecider = (layer: Layer.Layer<DeciderDeps>, task = "task"): Layer.Layer<Services> => Layer.provideMerge(deciderLayer(task, DECISION_FORMAT_TEXT), layer);

/** The layer of the six services with scripted agents and Ui over a temporary repository. */
export function testLayer(repo: string, options: TestOptions = {}): { layer: Layer.Layer<Services>; probe: Probe } {
  const paths = pathsOf(repo);
  const config: Config = { ...defaultConfig, questionPhase: false, ...options.config };
  const ui = new ScriptedUi(options.answers ?? []);
  const planner = new ScriptedPlanner(paths, options.steps ?? [], options.execs ?? [], options.execScripts ?? []);
  const reviewer = new ScriptedReviewer(paths, options.reviews ?? []);
  const wrap = options.store ?? ((s: StoreShape) => s);
  const store = Layer.effect(Store, makeStore(repo, config.ignorePaths).pipe(Effect.map(wrap))).pipe(Layer.provide(options.platform ?? platformLayer));
  const layer = withDecider(Layer.mergeAll(store, Layer.succeed(Ui, ui), Layer.succeed(Planner, planner), Layer.succeed(Reviewer, reviewer), Layer.succeed(RunConfig, config)));
  const dir = path.join(paths.project, "plan-review");
  const loadLog = (subject: SubjectId = { plan: 1 }): Promise<readonly LogEntry[]> =>
    Effect.runPromise(makeStore(repo, config.ignorePaths).pipe(Effect.flatMap((s) => s.loadLog(subject)), Effect.provide(platformLayer)));
  return { layer, probe: { dir, plan: paths.plan, requirements: path.join(dir, "requirements.md"), loadLog, ui, planner, reviewer, config } };
}

/** Runs the procedure against a layer and returns the number of execution phases. */
export const runTask = (layer: Layer.Layer<Services>, task = "task"): Promise<number> => Effect.runPromise(run(task).pipe(Effect.provide(layer)));

/** Runs the procedure and asserts that it fails with the given error tag and description texts. */
export async function runFails(layer: Layer.Layer<Services>, tag: RunError["_tag"], ...texts: RegExp[]): Promise<RunError> {
  const exit = await Effect.runPromiseExit(run("task").pipe(Effect.provide(layer)));
  assert.ok(Exit.isFailure(exit), "the run succeeded");
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(Option.isSome(error), `the run ended with a defect, not a typed error: ${Cause.pretty(exit.cause)}`);
  assert.equal(error.value._tag, tag);
  for (const text of texts) assert.match(describe(error.value), text);
  return error.value;
}

/** What a program test inspects: the scripted implementations, the paths, and the usage lines. */
export type WiringProbe = { ui: ScriptedUi; planner: ScriptedPlanner; reviewer: ScriptedReviewer; dir: string; usageLines: string[] };

/**
 * The wiring of the program with scripted agents and Ui over a temporary repository. The shared
 * config file is an empty object in a temporary directory, so the repository's own config.json
 * plays no part; `options.config` is written to the project's plan-review/config.json.
 */
export function testWiring(repo: string, options: TestOptions = {}): { wiring: Wiring; probe: WiringProbe } {
  const paths = pathsOf(repo);
  const dir = path.join(paths.project, "plan-review");
  const shared = path.join(tempDir("pr-shared-"), "config.json");
  fs.writeFileSync(shared, "{}");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ questionPhase: false, ...options.config }));
  const ui = new ScriptedUi(options.answers ?? []);
  const planner = new ScriptedPlanner(paths, options.steps ?? [], options.execs ?? [], options.execScripts ?? []);
  const reviewer = new ScriptedReviewer(paths, options.reviews ?? []);
  const usageLines: string[] = [];
  const wiring: Wiring = {
    ui: Effect.succeed(ui),
    platform: platformLayer,
    sdk: new FakeSdk(),
    // The scripted execution reports its call to the run's Ui, as the adapter does (issue #6: the current step).
    agents: Layer.mergeAll(
      Layer.effect(
        Planner,
        Effect.gen(function* () {
          planner.callUi = yield* Ui;
          return planner;
        }),
      ),
      Layer.succeed(Reviewer, reviewer),
    ),
    sharedConfig: shared,
    cwd: paths.project,
    usage: (text) => Effect.sync(() => void usageLines.push(text)),
  };
  return { wiring, probe: { ui, planner, reviewer, dir, usageLines } };
}
