import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { finished, issue, respond, runFails, runTask, tempRepo, testLayer } from "./helpers.ts";

const noQuestions = { questions_for_user: [] };

test("one accepted issue, then convergence, then finished", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("P1-R1-1")] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.deepEqual(probe.ui.asked, []);
  const log = probe.state.loadLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].action, "accepted");
  const conversation = fs.readFileSync(path.join(probe.state.dir, "conversation.md"), "utf8");
  assert.match(conversation, /\[P1-R1-1\]\*\* accepted/);
  assert.match(conversation, /The review of plan.md has converged/);
});

test("a rejected issue raised again produces one prompt", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["keep the rejection"],
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["A", "accepted"], ["B", "rejected"]]), plan: "v2" },
      { output: respond([["B", "rejected"]]) },
    ],
    reviews: [{ issues: [issue("A"), issue("B")] }, { issues: [issue("B")] }, { issues: [] }],
    execs: [finished],
  });
  await runTask(layer);
  assert.equal(probe.ui.asked.length, 1);
  assert.match(probe.ui.asked[0], /issue B, raised again/);
  const entries = probe.state.loadLog().filter((e) => e.id === "B");
  assert.deepEqual(entries.map((e) => e.superseded === true), [true, false]);
});

test("a stop with a question starts a second planning phase with a new Codex thread", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: noQuestions, plan: "v2" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [{ status: "needs_input", summary: "step 1", question: "A or B?", remainingWork: "steps 2-3", userInput: "B" }, finished],
  });
  assert.equal(await runTask(layer), 2);
  assert.equal(probe.reviewer.phases, 2);
  assert.ok(fs.existsSync(path.join(probe.state.dir, "planning-2", "cc-0.json")));
  assert.match(fs.readFileSync(path.join(probe.state.dir, "user-decisions.md"), "utf8"), /stop in execution phase 1 \(needs_input\): A or B\?\nDecision: B/);
  assert.deepEqual(probe.ui.asked, []);
});

test("a stop without a question asks the user for input", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["retry with smaller steps"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: noQuestions }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [{ status: "aborted", summary: "", question: "no status", remainingWork: "", userInput: null }, finished],
  });
  assert.equal(await runTask(layer), 2);
  assert.equal(probe.ui.asked.length, 1);
});

test("a planning call that changes the project halts the run", async () => {
  const { layer } = testLayer(tempRepo(), { steps: [{ output: noQuestions, plan: "v1", touchProject: true }] });
  await runFails(layer, "ProjectChanged", /changed during a planning-phase call/, /a\.txt/);
});

test("a change to an ignored path does not halt the run", async () => {
  const { layer } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1", touchProject: true }],
    reviews: [{ issues: [] }],
    execs: [finished],
    config: { ignorePaths: ["a.txt"] },
  });
  assert.equal(await runTask(layer), 1);
});

test("an accepted issue without a plan change halts the run", async () => {
  const { layer } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"]]) }],
    reviews: [{ issues: [issue("A")] }],
  });
  await runFails(layer, "AcceptedWithoutChange", /plan\.md is unchanged/);
});

test("the round limit offers to proceed to execution", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["p"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("A")] }],
    execs: [finished],
    config: { maxRounds: 1 },
  });
  assert.equal(await runTask(layer), 1);
  assert.match(probe.ui.asked[0], /1 rounds completed without convergence/);
});

test("a reversal and a disputed self-correction each produce a prompt and a decided_by_user entry", async () => {
  const reversal = {
    ...respond([["C", "rejected"]]),
    dispositions: [{ id: "C", action: "rejected" as const, rationale: "rationale C", duplicate_of: "", reverses: "A" }],
    self_corrections: [{ id: "A", new_action: "rejected" as const, explanation: "A breaks the migration" }, { id: "", new_action: "plan_error" as const, explanation: "wrong module" }],
  };
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["keep A", "keep A again"],
    steps: [
      { output: noQuestions, plan: "v1" },
      { output: respond([["A", "accepted"]]), plan: "v2" },
      { output: reversal, plan: "v3" },
      { output: noQuestions, plan: "v4" },
    ],
    reviews: [{ issues: [issue("A")] }, { issues: [issue("C")] }, { issues: [] }],
    execs: [finished],
  });
  await runTask(layer);
  assert.equal(probe.ui.asked.length, 2);
  const log = probe.state.loadLog();
  assert.ok(log.some((e) => e.id === "P1-S2-2" && e.action === "plan_error"));
  assert.equal(log.filter((e) => e.action === "decided_by_user").length, 2);
  assert.equal(log.filter((e) => e.id === "A" && e.superseded !== true).length, 1);
});

test("a second run archives the files of the first", async () => {
  const repo = tempRepo();
  const mk = () => testLayer(repo, { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }], execs: [finished] });
  await runTask(mk().layer, "first");
  fs.writeFileSync(path.join(repo, "plan-review", "config.json"), "{}");
  execFileSync("git", ["-C", repo, "checkout", "-q", "a.txt"]);
  const second = mk();
  await runTask(second.layer, "second");
  const names = fs.readdirSync(second.probe.state.dir);
  assert.equal(names.filter((n) => n.startsWith("archive-")).length, 1);
  assert.ok(names.includes("config.json"));
  assert.match(fs.readFileSync(path.join(second.probe.state.dir, "conversation.md"), "utf8"), /Task: second/);
});

test("0 at the round limit stops with RoundLimitStop", async () => {
  const { layer } = testLayer(tempRepo(), {
    answers: ["0"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("A")] }],
    config: { maxRounds: 1 },
  });
  await runFails(layer, "RoundLimitStop", /stopped by the user at the round limit of Planning phase 1/);
});

test("q at the round limit stops with UserStopped", async () => {
  const { layer } = testLayer(tempRepo(), {
    answers: ["q"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("A")] }],
    config: { maxRounds: 1 },
  });
  await runFails(layer, "UserStopped", /stopped by the user/);
});

test("q at a decision prompt stops with UserStopped", async () => {
  const { layer } = testLayer(tempRepo(), {
    answers: ["q"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"], ["B", "rejected"]]), plan: "v2" }],
    reviews: [{ issues: [issue("A"), issue("B")] }, { issues: [issue("B")] }],
  });
  await runFails(layer, "UserStopped", /stopped by the user/);
});

test("a missing disposition stops with MissingDispositions naming the id", async () => {
  const { layer } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("A"), issue("B")] }],
  });
  await runFails(layer, "MissingDispositions", /Claude Code returned no disposition for: B/);
});

test("no plan written stops with PlanNotWritten", async () => {
  const { layer } = testLayer(tempRepo(), { steps: [{ output: noQuestions }] });
  await runFails(layer, "PlanNotWritten", /did not write plan-review\/plan\.md/);
});

test("Codex changing the reviewed file stops with ReviewedFileChanged", async () => {
  const { layer } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [issue("A")], plan: "changed by the reviewer" }],
  });
  await runFails(layer, "ReviewedFileChanged", /plan\.md changed during a Codex review/);
});
