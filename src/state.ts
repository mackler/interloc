// Files in <project>/plan-review/ and the comparison of the project state.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Config, LogEntry } from "./types.ts";
import { defaultConfig } from "./types.ts";

/** Thrown to end the run. State on disk is preserved. */
export class Halt extends Error {}

export class State {
  readonly project: string;
  readonly dir: string;
  readonly plan: string;
  private readonly logFile: string;
  private readonly decisionsFile: string;
  private readonly feedbackFile: string;
  private readonly conversationFile: string;

  constructor(project: string) {
    this.project = path.resolve(project);
    this.dir = path.join(this.project, "plan-review");
    this.plan = path.join(this.dir, "plan.md");
    this.logFile = path.join(this.dir, "issue-log.json");
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
    this.saveLog([]);
    fs.writeFileSync(this.decisionsFile, "");
    fs.writeFileSync(this.feedbackFile, "");
    fs.writeFileSync(this.conversationFile, `# Conversation record\n\nTask: ${task}\n\n`);
  }

  loadConfig(): Config {
    const file = path.join(this.dir, "config.json");
    if (!fs.existsSync(file)) return defaultConfig;
    return { ...defaultConfig, ...(JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Config>) };
  }

  phaseDir(kind: "planning" | "execution", k: number): string {
    const dir = path.join(this.dir, `${kind}-${k}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  writeJson(file: string, value: unknown): void {
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
  }

  loadLog(): LogEntry[] {
    return JSON.parse(fs.readFileSync(this.logFile, "utf8")) as LogEntry[];
  }

  saveLog(log: LogEntry[]): void {
    this.writeJson(this.logFile, log);
  }

  recordDecision(subject: string, decision: string): void {
    fs.appendFileSync(this.decisionsFile, `Subject: ${subject}\nDecision: ${decision}\n\n`);
    this.converse(`**User decision** on ${subject}: ${decision}\n\n`);
  }

  recordFeedback(phase: number, round: number, text: string): void {
    fs.appendFileSync(this.feedbackFile, `## Planning phase ${phase}, round ${round}\n${text}\n\n`);
  }

  converse(markdown: string): void {
    fs.appendFileSync(this.conversationFile, markdown);
  }

  planExists(): boolean {
    return fs.existsSync(this.plan) && fs.statSync(this.plan).size > 0;
  }

  planHash(): string {
    return this.planExists() ? createHash("sha256").update(fs.readFileSync(this.plan)).digest("hex") : "";
  }

  /**
   * Hash of the project outside plan-review/: the list of changed and untracked paths and the diff of
   * tracked files. A change to the content of an untracked file is not detected.
   */
  projectState(): string {
    const git = (args: string[]): string =>
      execFileSync("git", ["-C", this.project, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    const status = git(["status", "--porcelain"])
      .split("\n")
      .filter((line) => !/^.. "?plan-review\//.test(line))
      .join("\n");
    return createHash("sha256").update(status).update(git(["diff"])).digest("hex");
  }
}
