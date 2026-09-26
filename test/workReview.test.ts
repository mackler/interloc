import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { platformLayer } from "../src/platform.ts";
import { limitNoProceedPrompt, execInputPrompt, planApplyDecisionsPrompt } from "../src/prompts.ts";
import { readCheckpoint } from "../src/records.ts";
import type { ExecOutcome } from "../src/schema.ts";
import type { StoreShape } from "../src/services.ts";
import { finished, issue, respond, runFails, runTask, tempRepo, testLayer } from "./helpers.ts";

// Plan step 2.8: the work review after every execution phase (the task; decisions Q7, Q13, Q14, G-R1-1).
const noQuestions = { questions_for_user: [] };
const planWrite = (plan: string) => ({ output: noQuestions, plan });
const read = (dir: string, name: string): string => fs.readFileSync(path.join(dir, name), "utf8");
const json = (dir: string, name: string) => JSON.parse(read(dir, name));
const workLog = (dir: string) => json(dir, "work-review-log.json").entries as { id: string; round: number; phase: number; source: string; action: string; rationale: string }[];

/** Captures checkpoint.json when the next planning call begins; `verify` later decodes it against the records. */
const checkpointAtCall = (dir: () => string) => {
  let captured: string | null = null;
  return {
    onCall: () => {
      captured = fs.readFileSync(path.join(dir(), "checkpoint.json"), "utf8");
    },
    verify: async () => {
      assert.ok(captured !== null, "no checkpoint was captured");
      const file = path.join(dir(), "checkpoint.json");
      const later = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, captured);
      const checkpoint = await Effect.runPromise(readCheckpoint(dir()).pipe(Effect.provide(platformLayer)));
      fs.writeFileSync(file, later);
      return checkpoint;
    },
  };
};

/** A store whose saveResponse of a work review round changes the project afterwards (after planningCall's guard). */
const changeAfterResponse = (repo: string, change: (round: number) => void) => (store: StoreShape): StoreShape => ({
  ...store,
  saveResponse: (subject, round, response) =>
    store.saveResponse(subject, round, response).pipe(Effect.tap(() => Effect.sync(() => (typeof subject === "object" && "work" in subject ? change(round) : undefined)))),
});

test("(a, g, h) a finished execution and a converged work review finish the run", async () => {
  const { layer, probe } = testLayer(tempRepo(), { steps: [planWrite("v1")], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] });
  assert.equal(await runTask(layer), 1);
  assert.deepEqual(json(probe.dir, "work-review-1/review-1.json"), { issues: [] });
  assert.equal(json(probe.dir, "work-review-1/round-1.json").kind, "no_response");
  assert.deepEqual([json(probe.dir, "checkpoint.json").subject, json(probe.dir, "checkpoint.json").stage], ["work-review-1", "reviewed"]);
  assert.match(read(probe.dir, "work-review-1/changes.diff"), /\+implemented/);
  assert.match(read(probe.dir, "conversation.md"), /## Work review 1, round 1/);
  assert.ok(probe.ui.notified.some((e) => e._tag === "PhaseBegan" && e.phase.kind === "work" && e.phase.n === 1));
  assert.match(probe.reviewer.prompts[1], /work-review-1\/changes\.diff/);
  assert.equal(probe.reviewer.phases, 2, "the work review has its own thread");
});

test("(b) an accepted work issue leads to planning 2, execution 2 and a second work review", async () => {
  const repo = tempRepo();
  const capture = checkpointAtCall(() => path.join(repo, "plan-review"));
  const { layer, probe } = testLayer(repo, {
    steps: [planWrite("v1"), { output: respond([["W1-R1-1", "accepted"]]) }, { ...planWrite("v2"), onCall: capture.onCall }],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
  });
  assert.equal(await runTask(layer), 2);
  assert.match(probe.planner.prompts[2], /Work review 1 ended in round 1/);
  assert.match(probe.planner.prompts[2], /work-review-1\/round-1\.json/);
  assert.ok(!probe.planner.prompts.includes(planApplyDecisionsPrompt), "a work review applied decisions with a planning call");
  assert.deepEqual(workLog(probe.dir).map((e) => [e.id, e.action]), [["W1-R1-1", "accepted"]]);
  assert.equal((await capture.verify())?.stage, "logged");
});

test("(b2) an accepted self-correction of an earlier work issue leaves for planning 2", async () => {
  const repo = tempRepo();
  const capture = checkpointAtCall(() => path.join(repo, "plan-review"));
  const self = { self_corrections: [{ id: "W1-R1-1", new_action: "accepted" as const, explanation: "the earlier issue is valid" }] };
  const { layer, probe } = testLayer(repo, {
    steps: [planWrite("v1"), { output: respond([["W1-R1-1", "rejected"]]) }, { output: respond([["W1-R2-1", "rejected"]], self) }, { ...planWrite("v2"), onCall: capture.onCall }],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [issue("W1-R2-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
  });
  assert.equal(await runTask(layer), 2);
  assert.ok(workLog(probe.dir).some((e) => e.source === "self_correction" && e.id === "W1-R1-1" && e.action === "accepted"));
  assert.equal((await capture.verify())?.stage, "logged");
});

test("(b3) changes.diff is rewritten for every round: an outside change after an empty answer is in round 2's file", async () => {
  const repo = tempRepo();
  const { layer, probe } = testLayer(repo, {
    answers: [""],
    steps: [planWrite("v1"), { output: respond([["W1-R1-1", "rejected"]]) }],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }],
    execs: [finished],
    store: changeAfterResponse(repo, () => fs.appendFileSync(path.join(repo, "a.txt"), "outside change\n")),
  });
  assert.equal(await runTask(layer), 1);
  assert.match(probe.ui.asked[0], /unexplained change to changes\.diff/);
  assert.match(read(probe.dir, "work-review-1/changes.diff"), /\+outside change/);
});

test("(c) exit (iii): a decision on a reraised work issue leaves for planning 2 with a valid decided checkpoint", async () => {
  const repo = tempRepo();
  const capture = checkpointAtCall(() => path.join(repo, "plan-review"));
  const { layer, probe } = testLayer(repo, {
    answers: ["act on it"],
    steps: [planWrite("v1"), { output: respond([["W1-R1-1", "rejected"]]) }, { ...planWrite("v2"), onCall: capture.onCall }],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [issue("W1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
  });
  assert.equal(await runTask(layer), 2);
  assert.match(probe.ui.asked[0], /issue W1-R1-1, raised again/);
  assert.deepEqual(workLog(probe.dir).at(-1)?.action, "decided_by_user");
  assert.match(read(probe.dir, "user-decisions.md"), /act on it/);
  assert.equal((await capture.verify())?.stage, "decided");
});

test("(c1) exit (i): a decision on a second clarification logs the round once with the decision and a valid logged checkpoint", async () => {
  const repo = tempRepo();
  const capture = checkpointAtCall(() => path.join(repo, "plan-review"));
  const { layer, probe } = testLayer(repo, {
    answers: ["this is what I mean"],
    steps: [planWrite("v1"), { output: respond([["W1-R1-1", "clarification_requested"]]) }, { output: respond([["W1-R1-1", "clarification_requested"]]) }, { ...planWrite("v2"), onCall: capture.onCall }],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [issue("W1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
  });
  assert.equal(await runTask(layer), 2);
  const round2 = workLog(probe.dir).filter((e) => e.round === 2);
  assert.deepEqual(round2.map((e) => [e.source, e.action]), [["review", "clarification_requested"], ["user", "decided_by_user"]]);
  assert.equal((await capture.verify())?.stage, "logged");
});

for (const [name, config, change, answers] of [
  ["(c2) exit (ii), unexplained change", {}, (repo: string) => () => fs.appendFileSync(path.join(repo, "a.txt"), "outside\n"), ["decide"]],
  ["(c4) exit (ii), idle rounds", { maxIdleRounds: 1 }, null, ["decide"]],
] as const) {
  test(`${name}: the decision leaves for planning 2; the log holds the round once and the decided checkpoint is valid`, async () => {
    const repo = tempRepo();
    const capture = checkpointAtCall(() => path.join(repo, "plan-review"));
    const { layer, probe } = testLayer(repo, {
      answers: [...answers],
      config,
      steps: [planWrite("v1"), { output: respond([["W1-R1-1", "rejected"]]) }, { ...planWrite("v2"), onCall: capture.onCall }],
      reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }, { issues: [] }],
      execs: [finished, finished],
      ...(change !== null ? { store: changeAfterResponse(repo, change(repo)) } : {}),
    });
    assert.equal(await runTask(layer), 2);
    assert.equal(workLog(probe.dir).filter((e) => e.id === "W1-R1-1" && e.source === "review").length, 1);
    assert.equal((await capture.verify())?.stage, "decided");
  });
}

test("(c3) exit (ii), identical content: a diff back to an earlier round's text, then a decision, leaves for planning 2", async () => {
  const repo = tempRepo();
  const capture = checkpointAtCall(() => path.join(repo, "plan-review"));
  let saved = "";
  const change = (round: number) => {
    const file = path.join(repo, "a.txt");
    if (round === 1) {
      saved = fs.readFileSync(file, "utf8");
      fs.appendFileSync(file, "temporary\n");
    } else fs.writeFileSync(file, saved);
  };
  const { layer, probe } = testLayer(repo, {
    answers: ["", "", "keep the first version"],
    config: { maxIdleRounds: 5 },
    steps: [planWrite("v1"), { output: respond([["W1-R1-1", "rejected"]]) }, { output: respond([["W1-R2-1", "rejected"]]) }, { ...planWrite("v2"), onCall: capture.onCall }],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [issue("W1-R2-1")] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
    store: changeAfterResponse(repo, change),
  });
  assert.equal(await runTask(layer), 2);
  assert.match(probe.ui.asked[2], /alternating versions of changes\.diff/);
  assert.equal((await capture.verify())?.stage, "decided");
});

test("(d) an empty decision at the idle pause continues the work review", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: [""],
    config: { maxIdleRounds: 1 },
    steps: [planWrite("v1"), { output: respond([["W1-R1-1", "rejected"]]) }],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }],
    execs: [finished],
  });
  assert.equal(await runTask(layer), 1);
  assert.equal(probe.reviewer.prompts.length, 3);
});

test("(e) the round limit of a work review has no p, and p stops the run", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["p"],
    config: { maxRounds: 1, maxIdleRounds: 5 },
    steps: [planWrite("v1"), { output: respond([["W1-R1-1", "rejected"]]) }],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }],
    execs: [finished],
  });
  await runFails(layer, "RoundLimitStop", /Work review 1/);
  assert.equal(probe.ui.asked[0], limitNoProceedPrompt(1));
});

test("(f) a Codex turn of the work review that changes the project halts with ProjectChanged", async () => {
  const { layer } = testLayer(tempRepo(), { steps: [planWrite("v1")], reviews: [{ issues: [] }, { issues: [], touchProject: true }], execs: [finished] });
  await runFails(layer, "ProjectChanged");
});

test("(f2) a Codex turn that edits only changes.diff halts with ReviewedFileChanged", async () => {
  const { layer } = testLayer(tempRepo(), { steps: [planWrite("v1")], reviews: [{ issues: [] }, { issues: [], editRecord: "work-review-1/changes.diff" }], execs: [finished] });
  await runFails(layer, "ReviewedFileChanged", /changes\.diff/);
});

test("(f3) the same edit during a repair turn halts the same way", async () => {
  const { layer } = testLayer(tempRepo(), {
    steps: [planWrite("v1")],
    reviews: [{ issues: [] }, { issues: [], raw: "not a review" }, { issues: [], editRecord: "work-review-1/changes.diff" }],
    execs: [finished],
  });
  await runFails(layer, "ReviewedFileChanged", /changes\.diff/);
});

const stop = (status: ExecOutcome["status"], userInput: string | null): ExecOutcome => ({ status, summary: "partial", question: "Which database?", remainingWork: "the rest", userInput });

test("(i) a needs_input stop is recorded, then the work review runs and converges, then planning 2; the run does not finish there", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [planWrite("v1"), planWrite("v2")],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [stop("needs_input", "PostgreSQL"), finished],
  });
  assert.equal(await runTask(layer), 2);
  assert.match(read(probe.dir, "user-decisions.md"), /stop in execution phase 1 \(needs_input\)[\s\S]*PostgreSQL/);
  assert.match(probe.reviewer.prompts[1], /work-review-1\/changes\.diff/);
  assert.match(probe.planner.prompts[1], /user's input for this stop/);
  assert.match(probe.planner.prompts[1], /Work review 1 found no issue in the work so far/);
});

test("(j) an aborted execution asks the user for input, then the work review runs, then planning 2", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    answers: ["go on"],
    steps: [planWrite("v1"), planWrite("v2")],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [stop("aborted", null), finished],
  });
  assert.equal(await runTask(layer), 2);
  assert.equal(probe.ui.asked[0], execInputPrompt);
  assert.equal(probe.reviewer.prompts.length, 4);
});

test("(k) a stop and a work review that leaves with revise: planning 2's prompt names both", async () => {
  const { layer, probe } = testLayer(tempRepo(), {
    steps: [planWrite("v1"), { output: respond([["W1-R1-1", "accepted"]]) }, planWrite("v2")],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1")] }, { issues: [] }, { issues: [] }],
    execs: [stop("needs_input", "PostgreSQL"), finished],
  });
  assert.equal(await runTask(layer), 2);
  assert.match(probe.planner.prompts[2], /user's input for this stop/);
  assert.match(probe.planner.prompts[2], /Work review 1 ended in round 1/);
});
