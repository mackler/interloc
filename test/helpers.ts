import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Planner, Reviewer } from "../src/agents.ts";
import type { Context } from "../src/review.ts";
import { Halt, State } from "../src/state.ts";
import { defaultConfig, type Config, type ExecOutcome, type PlannerResponse, type Review } from "../src/types.ts";
import type { Ui } from "../src/ui.ts";

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
    if (answer === "q") throw new Halt("stopped by the user");
    return answer;
  }
}

export type PlanningStep = { output: unknown; plan?: string; touchProject?: boolean };

export class ScriptedPlanner implements Planner {
  readonly prompts: string[] = [];
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
  async planning<T>(prompt: string): Promise<{ output: T; resultText: string; costUsd: number | null }> {
    this.prompts.push(prompt);
    const step = this.steps.shift();
    if (!step) throw new Error(`no scripted planning step for: ${prompt.slice(0, 60)}`);
    if (step.plan !== undefined) fs.writeFileSync(this.state.plan, step.plan);
    if (step.touchProject) fs.appendFileSync(path.join(this.state.project, "a.txt"), "changed\n");
    return { output: step.output as T, resultText: "", costUsd: 0.1 };
  }
  async executing(): Promise<ExecOutcome> {
    const outcome = this.execs.shift();
    if (!outcome) throw new Error("no scripted execution outcome");
    fs.appendFileSync(path.join(this.state.project, "a.txt"), "implemented\n");
    return outcome;
  }
}

export class ScriptedReviewer implements Reviewer {
  phases = 0;
  private readonly reviews: Review[];
  constructor(reviews: Review[]) {
    this.reviews = [...reviews];
  }
  newPhase(): void {
    this.phases++;
  }
  async review(): Promise<Review> {
    const review = this.reviews.shift();
    if (!review) throw new Error("no scripted review");
    return review;
  }
}

export const issue = (id: string, problem = "p"): Review["issues"][number] => ({ id, severity: "major", plan_section: "s", problem, evidence: "e" });

export const respond = (dispositions: [string, PlannerResponse["dispositions"][number]["action"]][], extra: Partial<PlannerResponse> = {}): PlannerResponse => ({
  dispositions: dispositions.map(([id, action]) => ({ id, action, rationale: `rationale ${id}`, duplicate_of: "", reverses: "" })),
  self_corrections: [],
  reviewer_feedback: "",
  questions_for_user: [],
  ...extra,
});

export const finished: ExecOutcome = { status: "finished", summary: "done", question: "", remainingWork: "", userInput: null };

export function context(repo: string, ui: Ui, steps: PlanningStep[], reviews: Review[], execs: ExecOutcome[], config: Partial<Config> = {}): Context & { planner: ScriptedPlanner; reviewer: ScriptedReviewer } {
  const state = new State(repo);
  return { state, ui, planner: new ScriptedPlanner(state, steps, execs), reviewer: new ScriptedReviewer(reviews), config: { ...defaultConfig, ...config } };
}
