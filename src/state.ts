// Files in <project>/plan-review/ and the comparison of the project state.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, LogEntry } from "./types.ts";
import { defaultConfig } from "./types.ts";

/** Thrown to end the run. State on disk is preserved. */
export class Halt extends Error {}

export class State {
  readonly project: string;
  readonly dir: string;
  readonly plan: string;
  readonly questions: string;
  readonly requirements: string;
  private readonly decisionsFile: string;
  private readonly feedbackFile: string;
  private readonly conversationFile: string;
  ignorePaths: string[] = [];

  constructor(project: string) {
    this.project = path.resolve(project);
    this.dir = path.join(this.project, "plan-review");
    this.plan = path.join(this.dir, "plan.md");
    this.questions = path.join(this.dir, "questions.json");
    this.requirements = path.join(this.dir, "requirements.md");
    this.decisionsFile = path.join(this.dir, "user-decisions.md");
    this.feedbackFile = path.join(this.dir, "reviewer-feedback.md");
    this.conversationFile = path.join(this.dir, "conversation.md");
  }

  /** Starts a new run. The files of an earlier run are moved to plan-review/archive-<time>/; config.json stays. */
  init(task: string): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const earlier = fs.readdirSync(this.dir).filter((name) => name !== "config.json" && !name.startsWith("archive-"));
    if (earlier.length > 0) {
      const archive = path.join(this.dir, `archive-${new Date().toISOString().replace(/[:.]/g, "-")}`);
      fs.mkdirSync(archive);
      for (const name of earlier) fs.renameSync(path.join(this.dir, name), path.join(archive, name));
    }
    for (const name of ["issue-log.json", "questions-log.json", "requirements-log.json"]) this.saveLog(name, []);
    fs.writeFileSync(this.decisionsFile, "");
    fs.writeFileSync(this.feedbackFile, "");
    fs.writeFileSync(this.conversationFile, `# Conversation record\n\nTask: ${task}\n\n`);
  }

  /**
   * Settings, in increasing precedence: the defaults, config.json in the orchestrator's repository
   * (for all projects), and plan-review/config.json in the project.
   */
  loadConfig(): Config {
    const read = (file: string): Partial<Config> => (fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Config>) : {});
    const shared = fileURLToPath(new URL("../config.json", import.meta.url));
    const config = { ...defaultConfig, ...read(shared), ...read(path.join(this.dir, "config.json")) };
    this.ignorePaths = config.ignorePaths;
    return config;
  }

  private ignored(file: string): boolean {
    return this.ignorePaths.some((p) => file === p || file.startsWith(p.endsWith("/") ? p : `${p}/`));
  }

  subDir(name: string): string {
    const dir = path.join(this.dir, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  writeJson(file: string, value: unknown): void {
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
  }

  loadLog(name = "issue-log.json"): LogEntry[] {
    return JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf8")) as LogEntry[];
  }

  saveLog(name: string, log: LogEntry[]): void {
    this.writeJson(path.join(this.dir, name), log);
  }

  recordDecision(subject: string, decision: string): void {
    fs.appendFileSync(this.decisionsFile, `Subject: ${subject}\nDecision: ${decision}\n\n`);
    this.converse(`**User decision** on ${subject}: ${decision}\n\n`);
  }

  recordFeedback(heading: string, round: number, text: string): void {
    fs.appendFileSync(this.feedbackFile, `## ${heading}, round ${round}\n${text}\n\n`);
  }

  /** Appends one line to usage.jsonl: the usage that an agent reported for one call. */
  recordUsage(entry: Record<string, unknown>): void {
    fs.appendFileSync(path.join(this.dir, "usage.jsonl"), JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n");
  }

  /** Number of calls and sum of the reported values per agent. */
  usageSummary(): string {
    const file = path.join(this.dir, "usage.jsonl");
    if (!fs.existsSync(file)) return "no usage recorded";
    const entries = fs.readFileSync(file, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, any>);
    const claude = entries.filter((e) => e.agent === "claude");
    const codex = entries.filter((e) => e.agent === "codex");
    const cost = claude.reduce((sum, e) => sum + (typeof e.total_cost_usd === "number" ? e.total_cost_usd : 0), 0);
    const input = codex.reduce((sum, e) => sum + (e.usage?.input_tokens ?? 0), 0);
    const output = codex.reduce((sum, e) => sum + (e.usage?.output_tokens ?? 0), 0);
    return `Claude Code: ${claude.length} calls, sum of reported total_cost_usd = ${cost.toFixed(2)} (an estimate by the client). Codex: ${codex.length} turns, ${input} input tokens, ${output} output tokens. Details: plan-review/usage.jsonl`;
  }

  converse(markdown: string): void {
    fs.appendFileSync(this.conversationFile, markdown);
  }

  planExists(): boolean {
    return fs.existsSync(this.plan) && fs.statSync(this.plan).size > 0;
  }

  fileHash(file: string): string {
    return fs.existsSync(file) ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : "";
  }

  writeText(file: string, text: string): void {
    fs.writeFileSync(file, text);
  }

  /**
   * The project outside plan-review/: the changed and untracked paths, and a hash of the diff of each
   * modified tracked file. A change to the content of an untracked file is not detected.
   */
  projectSnapshot(): Snapshot {
    const git = (args: string[]): string =>
      execFileSync("git", ["-C", this.project, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    const status = git(["status", "--porcelain"])
      .split("\n")
      .filter((line) => line !== "" && !/^.. "?plan-review\//.test(line))
      .filter((line) => !this.ignored(line.slice(3).replace(/^"|"$/g, "")));
    const diffs = new Map<string, string>();
    for (const name of git(["diff", "--name-only"]).split("\n").filter((n) => n !== "" && !this.ignored(n))) {
      diffs.set(name, createHash("sha256").update(git(["diff", "--", name])).digest("hex"));
    }
    return { status, diffs };
  }
}

export type Snapshot = { status: string[]; diffs: Map<string, string> };

/** The differences between two snapshots, one line per path. An empty result means no change. */
export function describeChange(before: Snapshot, after: Snapshot): string[] {
  const lines: string[] = [];
  for (const s of after.status) if (!before.status.includes(s)) lines.push(`new status line: ${s}`);
  for (const s of before.status) if (!after.status.includes(s)) lines.push(`status line gone: ${s}`);
  for (const [name, hash] of after.diffs) {
    if (before.diffs.has(name) && before.diffs.get(name) !== hash) lines.push(`content changed again: ${name}`);
  }
  return lines;
}
