import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import type { Schema } from "effect";
import type { RunError } from "../src/errors.ts";
import { describe, UserStopped } from "../src/errors.ts";
import type { Wiring } from "../src/program.ts";
import { run } from "../src/run.ts";
import * as S from "../src/schema.ts";
import { Planner, type PlannerShape, Reviewer, type ReviewerShape, RunConfig, type Services, Ui, type UiShape } from "../src/services.ts";
import { makeStore, platformLayer, storeLayer } from "../src/store.ts";
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

export function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-test-"));
  const git = (...args: string[]): void => void execFileSync("git", ["-C", dir, ...args]);
  git("init", "-q");
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  git("add", "a.txt");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return dir;
}

export class ScriptedUi implements UiShape {
  readonly said: string[] = [];
  readonly asked: string[] = [];
  private readonly answers: string[];
  constructor(answers: string[]) {
    this.answers = [...answers];
  }
  say(text: string): Effect.Effect<void> {
    return Effect.sync(() => void this.said.push(text));
  }
  /** The answer "q" fails with UserStopped; the answer "<wait>" never completes (for interruption tests). */
  ask(prompt: string): Effect.Effect<string, UserStopped> {
    return Effect.suspend(() => {
      this.asked.push(prompt);
      const answer = this.answers.shift();
      if (answer === undefined) return Effect.die(new Error(`no scripted answer for: ${prompt}`));
      if (answer === "q") return Effect.fail(new UserStopped({ where: prompt }));
      if (answer === "<wait>") return Effect.never;
      return Effect.succeed(answer);
    });
  }
  askMessage(prompt: string): Effect.Effect<string, UserStopped> {
    return this.ask(prompt);
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
      if (step.hang) return Effect.callback((_resume, signal) => void this.hangSignals.push(signal));
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
  readonly newPhase = Effect.sync(() => void this.phases++);
  /** Returns the reply text as Codex would: the caller decodes it. */
  review(prompt: string): Effect.Effect<string> {
    return Effect.sync(() => {
      this.prompts.push(prompt);
      this.callPhases.push(this.phases);
      const step = this.reviews.shift();
      if (!step) throw new Error("no scripted review");
      if (step.plan !== undefined) fs.writeFileSync(this.state.plan, step.plan);
      return step.raw ?? JSON.stringify({ issues: step.issues });
    });
  }
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

export type TestOptions = { answers?: string[]; steps?: PlanningStep[]; reviews?: ReviewStep[]; execs?: ExecOutcome[]; config?: Partial<Config> };
/** What a test inspects after a run: the scripted implementations, the paths, and a reader of the logs on disk. */
export type Probe = {
  dir: string;
  plan: string;
  requirements: string;
  loadLog: (name?: string) => Promise<LogEntry[]>;
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
  const store = Layer.provide(storeLayer(repo, config.ignorePaths), platformLayer);
  const layer = Layer.mergeAll(store, Layer.succeed(Ui, ui), Layer.succeed(Planner, planner), Layer.succeed(Reviewer, reviewer), Layer.succeed(RunConfig, config));
  const dir = path.join(paths.project, "plan-review");
  const loadLog = (name?: string): Promise<LogEntry[]> =>
    Effect.runPromise(makeStore(repo, config.ignorePaths).pipe(Effect.flatMap((s) => s.loadLog(name)), Effect.provide(platformLayer)));
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
  const shared = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pr-shared-")), "config.json");
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
