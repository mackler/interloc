// Files in <project>/plan-review/ and the comparison of the project state.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { ConfigInvalid, FileSystemError, GitError, StateFileInvalid } from "./errors.ts";
import * as S from "./schema.ts";
import { defaultConfig, firstIssue, PartialConfig } from "./schema.ts";
import type { Config, LogEntry, QuestionsFile } from "./schema.ts";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Every file-system call of this module goes through here, so no raw error escapes. */
const io = <T>(operation: string, file: string, action: () => T): T => {
  try {
    return action();
  } catch (e) {
    throw new FileSystemError({ operation, path: file, message: message(e) });
  }
};

/** Parses JSON of one of the program's own records; a parse error is StateFileInvalid. */
const parseJson = (file: string, text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new StateFileInvalid({ file, message: message(e) });
  }
};

/** Decodes parsed JSON of one of the program's own records; a mismatch is StateFileInvalid with the field path. */
const decodeRecord = <Out extends Schema.ConstraintDecoder<unknown>>(file: string, schema: Out, json: unknown, options: { readonly onExcessProperty: "ignore" | "error" } = { onExcessProperty: "error" }): Out["Type"] => {
  try {
    return Schema.decodeUnknownSync(schema, options)(json);
  } catch (e) {
    if (!Schema.isSchemaError(e)) throw e;
    const { path: at, message: text } = firstIssue(e);
    throw new StateFileInvalid({ file, message: at === "" ? text : `${text} (at ${at})` });
  }
};

/** Reads, parses and decodes a JSON file of the program's own records. */
const readJson = <Out extends Schema.ConstraintDecoder<unknown>>(file: string, schema: Out): Out["Type"] => {
  const text = io("read", file, () => fs.readFileSync(file, "utf8"));
  return decodeRecord(file, schema, parseJson(file, text));
};

const LogFile = Schema.Array(S.LogEntry);

const decodeConfigFile = Schema.decodeUnknownSync(PartialConfig, { onExcessProperty: "error" });

/** One config file, or {} if it does not exist. Invalid JSON, a wrong type and an unknown key are ConfigInvalid. */
const readConfigFile = (file: string): Partial<Config> => {
  if (!fs.existsSync(file)) return {};
  const text = io("read", file, () => fs.readFileSync(file, "utf8"));
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new ConfigInvalid({ file, path: "", message: message(e) });
  }
  try {
    return decodeConfigFile(json);
  } catch (e) {
    if (Schema.isSchemaError(e)) throw new ConfigInvalid({ file, ...firstIssue(e) });
    throw e;
  }
};

export class State {
  readonly project: string;
  readonly dir: string;
  readonly plan: string;
  readonly questions: string;
  readonly requirements: string;
  private readonly decisionsFile: string;
  private readonly feedbackFile: string;
  private readonly conversationFile: string;
  ignorePaths: readonly string[] = [];

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
    io("create directory", this.dir, () => fs.mkdirSync(this.dir, { recursive: true }));
    const earlier = io("list", this.dir, () => fs.readdirSync(this.dir)).filter((name) => name !== "config.json" && !name.startsWith("archive-"));
    if (earlier.length > 0) {
      const archive = path.join(this.dir, `archive-${new Date().toISOString().replace(/[:.]/g, "-")}`);
      io("create directory", archive, () => fs.mkdirSync(archive));
      for (const name of earlier) {
        io("move", path.join(this.dir, name), () => fs.renameSync(path.join(this.dir, name), path.join(archive, name)));
      }
    }
    for (const name of ["issue-log.json", "questions-log.json", "requirements-log.json"]) this.saveLog(name, []);
    this.writeText(this.decisionsFile, "");
    this.writeText(this.feedbackFile, "");
    this.writeText(this.conversationFile, `# Conversation record\n\nTask: ${task}\n\n`);
  }

  /**
   * Settings, in increasing precedence: the defaults, config.json in the orchestrator's repository
   * (for all projects), and plan-review/config.json in the project.
   */
  loadConfig(sharedFile: string = fileURLToPath(new URL("../config.json", import.meta.url)), projectFile: string = path.join(this.dir, "config.json")): Config {
    const config = { ...defaultConfig, ...readConfigFile(sharedFile), ...readConfigFile(projectFile) };
    this.ignorePaths = config.ignorePaths;
    return config;
  }

  private ignored(file: string): boolean {
    return this.ignorePaths.some((p) => file === p || file.startsWith(p.endsWith("/") ? p : `${p}/`));
  }

  subDir(name: string): string {
    const dir = path.join(this.dir, name);
    io("create directory", dir, () => fs.mkdirSync(dir, { recursive: true }));
    return dir;
  }

  writeJson(file: string, value: unknown): void {
    this.writeText(file, JSON.stringify(value, null, 2) + "\n");
  }

  /** plan-review/questions.json: the task and the agreed question list. */
  loadQuestions(): QuestionsFile {
    return readJson(this.questions, S.QuestionsFile);
  }

  loadLog(name = "issue-log.json"): LogEntry[] {
    return [...readJson(path.join(this.dir, name), LogFile)];
  }

  saveLog(name: string, log: LogEntry[]): void {
    this.writeJson(path.join(this.dir, name), log);
  }

  /** Keeps a reply that did not match its schema, as plan-review/invalid-replies/<agent>-<n>.json. Returns that relative path. */
  saveInvalidReply(agent: "claude" | "codex", content: string): string {
    const dir = this.subDir("invalid-replies");
    const n = io("list", dir, () => fs.readdirSync(dir)).filter((name) => name.startsWith(`${agent}-`)).length + 1;
    const name = `${agent}-${n}.json`;
    this.writeText(path.join(dir, name), content);
    return path.join("plan-review", "invalid-replies", name);
  }

  recordDecision(subject: string, decision: string): void {
    this.append(this.decisionsFile, `Subject: ${subject}\nDecision: ${decision}\n\n`);
    this.converse(`**User decision** on ${subject}: ${decision}\n\n`);
  }

  recordFeedback(heading: string, round: number, text: string): void {
    this.append(this.feedbackFile, `## ${heading}, round ${round}\n${text}\n\n`);
  }

  /** Appends one line to usage.jsonl: the usage that an agent reported for one call. */
  recordUsage(entry: Record<string, unknown>): void {
    this.append(path.join(this.dir, "usage.jsonl"), JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n");
  }

  /** Number of calls and sum of the reported values per agent. */
  usageSummary(): string {
    const file = path.join(this.dir, "usage.jsonl");
    if (!fs.existsSync(file)) return "no usage recorded";
    const lines = io("read", file, () => fs.readFileSync(file, "utf8")).split("\n").filter((l) => l !== "");
    // Excess properties are ignored: the SDKs decide which usage fields they report.
    const entries = lines.map((line) => decodeRecord(file, S.UsageEntry, parseJson(file, line), { onExcessProperty: "ignore" }));
    const claude = entries.filter((e) => e.agent === "claude");
    const codex = entries.filter((e) => e.agent === "codex");
    const cost = claude.reduce((sum, e) => sum + (typeof e.total_cost_usd === "number" ? e.total_cost_usd : 0), 0);
    const input = codex.reduce((sum, e) => sum + (e.usage?.input_tokens ?? 0), 0);
    const output = codex.reduce((sum, e) => sum + (e.usage?.output_tokens ?? 0), 0);
    return `Claude Code: ${claude.length} calls, sum of reported total_cost_usd = ${cost.toFixed(2)} (an estimate by the client). Codex: ${codex.length} turns, ${input} input tokens, ${output} output tokens. Details: plan-review/usage.jsonl`;
  }

  converse(markdown: string): void {
    this.append(this.conversationFile, markdown);
  }

  private append(file: string, text: string): void {
    io("append to", file, () => fs.appendFileSync(file, text));
  }

  planExists(): boolean {
    return fs.existsSync(this.plan) && io("read", this.plan, () => fs.statSync(this.plan)).size > 0;
  }

  fileHash(file: string): string {
    return fs.existsSync(file) ? createHash("sha256").update(io("read", file, () => fs.readFileSync(file))).digest("hex") : "";
  }

  writeText(file: string, text: string): void {
    io("write", file, () => fs.writeFileSync(file, text));
  }

  /**
   * The project outside plan-review/: the changed and untracked paths, and a hash of the diff of each
   * modified tracked file. A change to the content of an untracked file is not detected.
   */
  projectSnapshot(): Snapshot {
    const git = (args: string[]): string => {
      try {
        return execFileSync("git", ["-C", this.project, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        throw new GitError({ args, message: message(e) });
      }
    };
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
