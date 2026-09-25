import assert from "node:assert/strict";
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
import { Planner, type PlannerShape, Reviewer, type ReviewerShape, type ReviewSession, RunConfig, type Services, Ui, type UiShape } from "../src/services.ts";
import { type Platform, platformLayer } from "../src/platform.ts";
import { makeStore, storeLayer } from "../src/store.ts";
import { FakeSdk } from "./fakeSdk.ts";

type Config = typeof S.Config.Type;
type ExecOutcome = typeof S.ExecOutcome.Type;
type PlannerResponse = typeof S.PlannerResponse.Type;
type Review = typeof S.Review.Type;
type LogEntry = typeof S.LogEntry.Type;
const { defaultConfig } = S;

/** The paths a scripted agent writes to. */
export type Paths = { readonly project: string; readonly plan: string };
export const pathsOf = (repo: string): Paths => ({ project: path.resolve(repo), plan: path.join(repo, "plan-review", "plan.md") });

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
  private readonly answers: ScriptedAnswer[];
  private readonly asks = readiness();
  constructor(answers: readonly ScriptedAnswer[]) {
    this.answers = [...answers];
  }
  /** Resolves when the next prompt is asked. */
  nextAsk(): Promise<void> {
    return this.asks.wait();
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
export type PlanningStep = { output?: unknown; plan?: string; touchProject?: boolean; hang?: boolean };

export class ScriptedPlanner implements PlannerShape {
  readonly prompts: string[] = [];
  /** The Effect schema of each planning call, in order. */
  readonly schemas: Schema.Top[] = [];
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
  constructor(state: Paths, steps: PlanningStep[], execs: ExecOutcome[]) {
    this.state = state;
    this.steps = [...steps];
    this.execs = [...execs];
  }
  readonly sessionId = Effect.succeed("test-session");
  /** Returns the scripted output as it is: the caller decodes it, as with the real agent. */
  planning(prompt: string, schema: Schema.Top): Effect.Effect<{ output: unknown; resultText: string; costUsd: number | null }> {
    return Effect.suspend(() => {
      this.prompts.push(prompt);
      this.schemas.push(schema);
      const step = this.steps.shift();
      if (!step) return Effect.die(new Error(`no scripted planning step for: ${prompt.slice(0, 60)}`));
      if (step.hang) {
        return Effect.callback((_resume, signal) => {
          this.hangSignals.push(signal);
          this.hangs.signal();
        });
      }
      if (step.plan !== undefined) fs.writeFileSync(this.state.plan, step.plan);
      if (step.touchProject) fs.appendFileSync(path.join(this.state.project, "a.txt"), "changed\n");
      return Effect.succeed({ output: step.output, resultText: "", costUsd: 0.1 });
    });
  }
  executing(): Effect.Effect<ExecOutcome> {
    return Effect.sync(() => {
      const outcome = this.execs.shift();
      if (!outcome) throw new Error("no scripted execution outcome");
      fs.appendFileSync(path.join(this.state.project, "a.txt"), "implemented\n");
      return outcome;
    });
  }
}

/**
 * A scripted review. `plan` makes the reviewer change plan.md during its turn, as Codex could.
 * `raw` replaces the reply text, for a reply that is not a review (or not JSON).
 */
export type ReviewStep = Review & { plan?: string; raw?: string };

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
          if (step.plan !== undefined) fs.writeFileSync(this.state.plan, step.plan);
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

export type TestOptions = { answers?: readonly ScriptedAnswer[]; steps?: PlanningStep[]; reviews?: ReviewStep[]; execs?: ExecOutcome[]; config?: Partial<Config>; platform?: Layer.Layer<Platform> };

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

/** The layer of the five services with scripted agents and Ui over a temporary repository. */
export function testLayer(repo: string, options: TestOptions = {}): { layer: Layer.Layer<Services>; probe: Probe } {
  const paths = pathsOf(repo);
  const config: Config = { ...defaultConfig, questionPhase: false, ...options.config };
  const ui = new ScriptedUi(options.answers ?? []);
  const planner = new ScriptedPlanner(paths, options.steps ?? [], options.execs ?? []);
  const reviewer = new ScriptedReviewer(paths, options.reviews ?? []);
  const store = Layer.provide(storeLayer(repo, config.ignorePaths), options.platform ?? platformLayer);
  const layer = Layer.mergeAll(store, Layer.succeed(Ui, ui), Layer.succeed(Planner, planner), Layer.succeed(Reviewer, reviewer), Layer.succeed(RunConfig, config));
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
  const planner = new ScriptedPlanner(paths, options.steps ?? [], options.execs ?? []);
  const reviewer = new ScriptedReviewer(paths, options.reviews ?? []);
  const usageLines: string[] = [];
  const wiring: Wiring = {
    ui: Effect.succeed(ui),
    platform: platformLayer,
    sdk: new FakeSdk(),
    agents: Layer.mergeAll(Layer.succeed(Planner, planner), Layer.succeed(Reviewer, reviewer)),
    sharedConfig: shared,
    cwd: paths.project,
    usage: (text) => Effect.sync(() => void usageLines.push(text)),
  };
  return { wiring, probe: { ui, planner, reviewer, dir, usageLines } };
}
