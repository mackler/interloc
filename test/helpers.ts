import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import type { Schema } from "effect";
import type { Planner, Reviewer } from "../src/agents.ts";
import { plannerLayer, reviewerLayer } from "../src/agents.ts";
import type { RunError } from "../src/errors.ts";
import { describe, UserStopped } from "../src/errors.ts";
import { run } from "../src/run.ts";
import * as S from "../src/schema.ts";
import { RunConfig, type Services } from "../src/services.ts";
import { State, storeLayer } from "../src/state.ts";
import type { Ui } from "../src/ui.ts";
import { uiLayer } from "../src/ui.ts";

type Config = typeof S.Config.Type;
type ExecOutcome = typeof S.ExecOutcome.Type;
type PlannerResponse = typeof S.PlannerResponse.Type;
type Review = typeof S.Review.Type;
const { defaultConfig } = S;

export function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-test-"));
  const git = (...args: string[]): void => void execFileSync("git", ["-C", dir, ...args]);
  git("init", "-q");
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  git("add", "a.txt");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return dir;
}

export class ScriptedUi implements Ui {
  readonly said: string[] = [];
  readonly asked: string[] = [];
  private readonly answers: string[];
  constructor(answers: string[]) {
    this.answers = [...answers];
  }
  say(text: string): void {
    this.said.push(text);
  }
  async ask(prompt: string): Promise<string> {
    this.asked.push(prompt);
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error(`no scripted answer for: ${prompt}`);
    if (answer === "q") throw new UserStopped({ where: prompt });
    return answer;
  }
  askMessage(prompt: string): Promise<string> {
    return this.ask(prompt);
  }
}

export type PlanningStep = { output: unknown; plan?: string; touchProject?: boolean };

export class ScriptedPlanner implements Planner {
  readonly prompts: string[] = [];
  /** The Effect schema of each planning call, in order. */
  readonly schemas: Schema.Top[] = [];
  private readonly state: State;
  private readonly steps: PlanningStep[];
  private readonly execs: ExecOutcome[];
  constructor(state: State, steps: PlanningStep[], execs: ExecOutcome[]) {
    this.state = state;
    this.steps = [...steps];
    this.execs = [...execs];
  }
  sessionId(): string {
    return "test-session";
  }
  /** Returns the scripted output as it is: the caller decodes it, as with the real agent. */
  async planning(prompt: string, schema: Schema.Top): Promise<{ output: unknown; resultText: string; costUsd: number | null }> {
    this.prompts.push(prompt);
    this.schemas.push(schema);
    const step = this.steps.shift();
    if (!step) throw new Error(`no scripted planning step for: ${prompt.slice(0, 60)}`);
    if (step.plan !== undefined) fs.writeFileSync(this.state.plan, step.plan);
    if (step.touchProject) fs.appendFileSync(path.join(this.state.project, "a.txt"), "changed\n");
    return { output: step.output, resultText: "", costUsd: 0.1 };
  }
  async executing(): Promise<ExecOutcome> {
    const outcome = this.execs.shift();
    if (!outcome) throw new Error("no scripted execution outcome");
    fs.appendFileSync(path.join(this.state.project, "a.txt"), "implemented\n");
    return outcome;
  }
}

/**
 * A scripted review. `plan` makes the reviewer change plan.md during its turn, as Codex could.
 * `raw` replaces the reply text, for a reply that is not a review (or not JSON).
 */
export type ReviewStep = Review & { plan?: string; raw?: string };

export class ScriptedReviewer implements Reviewer {
  phases = 0;
  readonly prompts: string[] = [];
  /** The phase number at each review call, so that a test can see that two calls shared a thread. */
  readonly callPhases: number[] = [];
  private readonly state: State;
  private readonly reviews: ReviewStep[];
  constructor(state: State, reviews: ReviewStep[]) {
    this.state = state;
    this.reviews = [...reviews];
  }
  newPhase(): void {
    this.phases++;
  }
  /** Returns the reply text as Codex would: the caller decodes it. */
  async review(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    this.callPhases.push(this.phases);
    const step = this.reviews.shift();
    if (!step) throw new Error("no scripted review");
    if (step.plan !== undefined) fs.writeFileSync(this.state.plan, step.plan);
    return step.raw ?? JSON.stringify({ issues: step.issues });
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
/** What a test inspects after a run: the scripted implementations and the state on disk. */
export type Probe = { state: State; ui: ScriptedUi; planner: ScriptedPlanner; reviewer: ScriptedReviewer; config: Config };

/** The layer of the five services with scripted agents and Ui over a temporary repository. */
export function testLayer(repo: string, options: TestOptions = {}): { layer: Layer.Layer<Services>; probe: Probe } {
  const state = new State(repo);
  const config: Config = { ...defaultConfig, questionPhase: false, ...options.config };
  state.ignorePaths = config.ignorePaths;
  const ui = new ScriptedUi(options.answers ?? []);
  const planner = new ScriptedPlanner(state, options.steps ?? [], options.execs ?? []);
  const reviewer = new ScriptedReviewer(state, options.reviews ?? []);
  const layer = Layer.mergeAll(storeLayer(state), uiLayer(ui), plannerLayer(planner), reviewerLayer(reviewer), Layer.succeed(RunConfig, config));
  return { layer, probe: { state, ui, planner, reviewer, config } };
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
