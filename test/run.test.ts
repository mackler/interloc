import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { run } from "../src/run.ts";
import { Halt } from "../src/state.ts";
import { context, finished, issue, respond, ScriptedUi, tempRepo } from "./helpers.ts";

const noQuestions = { questions_for_user: [] };

test("one accepted issue, then convergence, then finished", async () => {
  const repo = tempRepo();
  const ui = new ScriptedUi([]);
  const ctx = context(repo, ui,
    [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }],
    [{ issues: [issue("P1-R1-1")] }, { issues: [] }],
    [finished]);
  assert.equal(await run(ctx, "task"), 1);
  assert.deepEqual(ui.asked, []);
  const log = ctx.state.loadLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].action, "accepted");
  const conversation = fs.readFileSync(path.join(ctx.state.dir, "conversation.md"), "utf8");
  assert.match(conversation, /\[P1-R1-1\]\*\* accepted/);
  assert.match(conversation, /The review of plan.md has converged/);
});

test("a rejected issue raised again produces one prompt", async () => {
  const repo = tempRepo();
  const ui = new ScriptedUi(["keep the rejection"]);
  const ctx = context(repo, ui,
    [
      { output: noQuestions, plan: "v1" },
      { output: respond([["A", "accepted"], ["B", "rejected"]]), plan: "v2" },
      { output: respond([["B", "rejected"]]) },
    ],
    [{ issues: [issue("A"), issue("B")] }, { issues: [issue("B")] }, { issues: [] }],
    [finished]);
  await run(ctx, "task");
  assert.equal(ui.asked.length, 1);
  assert.match(ui.asked[0], /issue B, raised again/);
  const entries = ctx.state.loadLog().filter((e) => e.id === "B");
  assert.deepEqual(entries.map((e) => e.superseded === true), [true, false]);
});

test("a stop with a question starts a second planning phase with a new Codex thread", async () => {
  const repo = tempRepo();
  const ui = new ScriptedUi([]);
  const ctx = context(repo, ui,
    [{ output: noQuestions, plan: "v1" }, { output: noQuestions, plan: "v2" }],
    [{ issues: [] }, { issues: [] }],
    [{ status: "needs_input", summary: "step 1", question: "A or B?", remainingWork: "steps 2-3", userInput: "B" }, finished]);
  assert.equal(await run(ctx, "task"), 2);
  assert.equal(ctx.reviewer.phases, 2);
  assert.ok(fs.existsSync(path.join(ctx.state.dir, "planning-2", "cc-0.json")));
  assert.match(fs.readFileSync(path.join(ctx.state.dir, "user-decisions.md"), "utf8"), /stop in execution phase 1 \(needs_input\): A or B\?\nDecision: B/);
  assert.deepEqual(ui.asked, []);
});

test("a stop without a question asks the user for input", async () => {
  const repo = tempRepo();
  const ui = new ScriptedUi(["retry with smaller steps"]);
  const ctx = context(repo, ui,
    [{ output: noQuestions, plan: "v1" }, { output: noQuestions }],
    [{ issues: [] }, { issues: [] }],
    [{ status: "aborted", summary: "", question: "no status", remainingWork: "", userInput: null }, finished]);
  assert.equal(await run(ctx, "task"), 2);
  assert.equal(ui.asked.length, 1);
});

test("a planning call that changes the project halts the run", async () => {
  const repo = tempRepo();
  const ctx = context(repo, new ScriptedUi([]), [{ output: noQuestions, plan: "v1", touchProject: true }], [], []);
  await assert.rejects(run(ctx, "task"), (e: unknown) => e instanceof Halt && /changed during a planning-phase call/.test(e.message) && /a\.txt/.test(e.message));
});

test("a change to an ignored path does not halt the run", async () => {
  const repo = tempRepo();
  const ctx = context(repo, new ScriptedUi([]), [{ output: noQuestions, plan: "v1", touchProject: true }], [{ issues: [] }], [finished], { ignorePaths: ["a.txt"] });
  assert.equal(await run(ctx, "task"), 1);
});

test("an accepted issue without a plan change halts the run", async () => {
  const repo = tempRepo();
  const ctx = context(repo, new ScriptedUi([]),
    [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"]]) }],
    [{ issues: [issue("A")] }], []);
  await assert.rejects(run(ctx, "task"), (e: unknown) => e instanceof Halt && /plan.md is unchanged/.test(e.message));
});

test("the round limit offers to proceed to execution", async () => {
  const repo = tempRepo();
  const ui = new ScriptedUi(["p"]);
  const ctx = context(repo, ui,
    [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"]]), plan: "v2" }],
    [{ issues: [issue("A")] }],
    [finished], { maxRounds: 1 });
  assert.equal(await run(ctx, "task"), 1);
  assert.match(ui.asked[0], /1 rounds completed without convergence/);
});

test("a reversal and a disputed self-correction each produce a prompt and a decided_by_user entry", async () => {
  const repo = tempRepo();
  const ui = new ScriptedUi(["keep A", "keep A again"]);
  const reversal = respond([["C", "rejected"]]);
  reversal.dispositions[0].reverses = "A";
  reversal.self_corrections = [{ id: "A", new_action: "rejected", explanation: "A breaks the migration" }, { id: "", new_action: "plan_error", explanation: "wrong module" }];
  const ctx = context(repo, ui,
    [
      { output: noQuestions, plan: "v1" },
      { output: respond([["A", "accepted"]]), plan: "v2" },
      { output: reversal, plan: "v3" },
      { output: noQuestions, plan: "v4" },
    ],
    [{ issues: [issue("A")] }, { issues: [issue("C")] }, { issues: [] }],
    [finished]);
  await run(ctx, "task");
  assert.equal(ui.asked.length, 2);
  const log = ctx.state.loadLog();
  assert.ok(log.some((e) => e.id === "P1-S2-2" && e.action === "plan_error"));
  assert.equal(log.filter((e) => e.action === "decided_by_user").length, 2);
  assert.equal(log.filter((e) => e.id === "A" && e.superseded !== true).length, 1);
});

test("a second run archives the files of the first", async () => {
  const repo = tempRepo();
  const mk = () => context(repo, new ScriptedUi([]), [{ output: noQuestions, plan: "v1" }], [{ issues: [] }], [finished]);
  await run(mk(), "first");
  fs.writeFileSync(path.join(repo, "plan-review", "config.json"), "{}");
  execFileSyncReset(repo);
  const second = mk();
  await run(second, "second");
  const names = fs.readdirSync(second.state.dir);
  assert.equal(names.filter((n) => n.startsWith("archive-")).length, 1);
  assert.ok(names.includes("config.json"));
  assert.match(fs.readFileSync(path.join(second.state.dir, "conversation.md"), "utf8"), /Task: second/);
});

import { execFileSync } from "node:child_process";
function execFileSyncReset(repo: string): void {
  execFileSync("git", ["-C", repo, "checkout", "-q", "a.txt"]);
}
