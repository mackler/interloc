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
  const log = await probe.loadLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].action, "accepted");
  const conversation = fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8");
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
  const entries = (await probe.loadLog()).filter((e) => e.id === "B");
  assert.deepEqual(entries.map((e) => e.superseded === true), [true, true, false]);
  // Finding 15: the decision on the reraised issue is one typed decision, so it is in the issue log too.
  assert.equal(entries.at(-1)?.action, "decided_by_user");
  assert.equal(entries.at(-1)?.rationale, "keep the rejection");
});

test("a stop with a question starts a second planning phase with a new Codex thread", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: noQuestions, plan: "v2" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [{ status: "needs_input", summary: "step 1", question: "A or B?", remainingWork: "steps 2-3", userInput: "B" }, finished],
  });
  assert.equal(await runTask(layer), 2);
  assert.equal(probe.reviewer.phases, 2);
  assert.ok(fs.existsSync(path.join(probe.dir, "planning-2", "cc-0.json")));
  assert.match(fs.readFileSync(path.join(probe.dir, "user-decisions.md"), "utf8"), /stop in execution phase 1 \(needs_input\): A or B\?\nDecision: B/);
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
  const log = await probe.loadLog();
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
  const names = fs.readdirSync(second.probe.dir);
  assert.equal(names.filter((n) => n.startsWith("archive-")).length, 1);
  assert.ok(names.includes("config.json"));
  assert.match(fs.readFileSync(path.join(second.probe.dir, "conversation.md"), "utf8"), /Task: second/);
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

test("a missing disposition stops with RoundInvalid naming the id", async () => {
  const { layer } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("A"), issue("B")] }],
  });
  await runFails(layer, "RoundInvalid", /Claude Code returned no disposition for: B/);
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

// Finding 14 of docs/functional-design-review.md: after an idle-round decision appended a second hash for one
// round, the position in the history was printed as a round number.
test("the identical-content message names the round after which the content was seen, also after an idle decision", async () => {
  const reject = (id: string, plan?: string) => ({ output: respond([[id, "rejected"]]), ...(plan === undefined ? {} : { plan }) });
  const { layer, probe } = testLayer(tempRepo(), {
    // round 1: unexplained change (no decision), idle prompt (a decision that applies changes -> v3)
    // rounds 2 and 3: unexplained change and idle prompt, no decisions; round 4: the plan is v4 again
    answers: ["", "apply the missing step", "", "", "", "", "", "", ""],
    steps: [
      { output: noQuestions, plan: "v1" },
      reject("A", "v2"),
      { output: noQuestions, plan: "v3" }, // applies the decision of round 1
      reject("B", "v4"),
      reject("C", "v5"),
      reject("D", "v4"),
    ],
    reviews: [{ issues: [issue("A")] }, { issues: [issue("B")] }, { issues: [issue("C")] }, { issues: [issue("D")] }, { issues: [] }],
    execs: [finished],
    config: { maxIdleRounds: 1, maxRounds: 6 },
  });
  assert.equal(await runTask(layer), 1);
  const identical = probe.ui.said.filter((line) => /is identical to plan\.md after/.test(line));
  assert.equal(identical.length, 1, probe.ui.said.join("\n"));
  assert.match(identical[0], /identical to plan\.md after round 2\b/);
});

// Finding 3 of docs/functional-design-review.md: duplicate or extra dispositions and duplicate review ids passed
// the presence check, so counts and the recorded actions could disagree. Decision Q3: a structural halt.
test("two dispositions for one issue halt the run with RoundInvalid naming the id", async () => {
  const { layer } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "rejected"], ["A", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("A")] }],
  });
  await runFails(layer, "RoundInvalid", /\bA\b/);
});

test("a disposition for an id that is not in the review halts the run with RoundInvalid naming the id", async () => {
  const { layer } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"], ["B", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("A")] }],
  });
  await runFails(layer, "RoundInvalid", /\bB\b/);
});

test("a review with two issues of the same id halts the run with RoundInvalid before any response", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [issue("A", "first"), issue("A", "second")] }],
  });
  await runFails(layer, "RoundInvalid", /\bA\b/);
  assert.equal(probe.planner.prompts.length, 1, "Claude Code was asked to respond to an invalid review");
});

test("a review with two minor issues of the same id halts instead of converging when minor issues do not count", async () => {
  const minor = (id: string) => ({ ...issue(id), severity: "minor" as const });
  const { layer } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [minor("A"), minor("A")] }],
    execs: [finished],
    config: { countMinor: false },
  });
  await runFails(layer, "RoundInvalid", /\bA\b/);
});

test("a missing disposition still halts, now as RoundInvalid, naming the id", async () => {
  const { layer } = testLayer(tempRepo(), {
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("A"), issue("B")] }],
  });
  await runFails(layer, "RoundInvalid", /returned no disposition for: B/);
});

// Finding 5 of docs/functional-design-review.md: the extra-rounds answer accepted integers beyond safe range.
test("at the round limit, an integer beyond the safe range is an invalid answer and stops; a small one adds rounds", async () => {
  const huge = testLayer(tempRepo(), {
    answers: ["99999999999999999999"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("A")] }],
    config: { maxRounds: 1 },
  });
  await runFails(huge.layer, "RoundLimitStop", /round limit/);

  const three = testLayer(tempRepo(), {
    answers: ["3"],
    steps: [{ output: noQuestions, plan: "v1" }, { output: respond([["A", "accepted"]]), plan: "v2" }],
    reviews: [{ issues: [issue("A")] }, { issues: [] }],
    execs: [finished],
    config: { maxRounds: 1 },
  });
  assert.equal(await runTask(three.layer), 1);
  assert.ok(three.probe.ui.said.some((line) => /round 2 \(limit 4\)/.test(line)), three.probe.ui.said.join("\n"));
});
