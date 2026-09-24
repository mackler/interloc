import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { tempRepo } from "./helpers.ts";

// The real entry point as a child process. Every case here makes the run stop before an agent is
// constructed, so no credentials are needed. The timeout is a guard: if the entry point ever got past
// the config, it would start a real agent, and the guard ends the process instead.
const main = new URL("../src/main.ts", import.meta.url).pathname;
const runMain = (repo: string): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(process.execPath, [main, "task", repo], { encoding: "utf8", timeout: 30_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};
const withConfig = (text: string): string => {
  const repo = tempRepo();
  fs.mkdirSync(path.join(repo, "plan-review"));
  fs.writeFileSync(path.join(repo, "plan-review", "config.json"), text);
  return repo;
};

test("an invalid project config.json prints HALTED with the file and field and exits 1", () => {
  const repo = withConfig(JSON.stringify({ maxRounds: "5" }));
  const result = runMain(repo);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /HALTED: .*plan-review\/config\.json is not a valid configuration: .*\(at maxRounds\)/);
  assert.match(result.stdout, /Claude Code session id: none/);
  assert.match(result.stdout, /Usage: /);
  assert.ok(!fs.existsSync(path.join(repo, "plan-review", "conversation.md")), "the records were initialised");
});

test("a config with invalid JSON prints HALTED and exits 1", () => {
  const repo = withConfig("{");
  const result = runMain(repo);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /HALTED: .*plan-review\/config\.json is not a valid configuration/);
  assert.match(result.stdout, /Claude Code session id: none/);
  assert.match(result.stdout, /Usage: /);
  assert.ok(!fs.existsSync(path.join(repo, "plan-review", "conversation.md")), "the records were initialised");
});

test("without a task the entry point prints the usage and exits 2", () => {
  const result = spawnSync(process.execPath, [main], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: node main\.ts/);
});
