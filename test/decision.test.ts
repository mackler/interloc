import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { askOffering, decisionLoop, limitOptions, numberedOptions, type OfferedQuestion, permissionOptions } from "../src/decision.ts";
import * as prompts from "../src/prompts.ts";
import { withOffer } from "../src/prompts.ts";
import type { RunError } from "../src/errors.ts";
import type { DecisionAnalysis, Entry } from "../src/schema.ts";
import { Decider, type DecisionQuestion, type Services, Store, Ui } from "../src/services.ts";
import { issue, respond, tempRepo, testLayer, type TestOptions } from "./helpers.ts";

// Decision support, plan step 2.5: the decision loop over the scripted agents.
const FORMAT = fs.readFileSync(new URL("../docs/decision-making.md", import.meta.url), "utf8");
const question: DecisionQuestion = { phase: { kind: "planning", n: 1 }, question: "Which database?", options: [{ label: "SQLite", description: "a file" }, { label: "PostgreSQL", description: "a server" }] };
const el = (text = "t", counterarguments: Entry["threshold"]["counterarguments"] = []) => ({ text, counterarguments });
const entry = (id: string, title = `title ${id}`, counter: Entry["threshold"]["counterarguments"] = []): Entry => ({
  id,
  title,
  comparative_condition: el("c", counter),
  starting_cause: el(),
  intermediate_steps: el(),
  threshold: el(),
  effect_on_persons: el(),
  reason_the_effect_matters: el(),
  extent: { per_person: el(), persons_affected: el(), likelihood: el(), timing: el() },
});
const analysis = (title = "first"): DecisionAnalysis => ({
  decision: "Which database?",
  columns: [
    { option: "SQLite", advantages: [entry("E1", title)], disadvantages: [] },
    { option: "PostgreSQL", advantages: [], disadvantages: [entry("E2")] },
  ],
  recommendation: { option: "", reason: "" },
});
const decisionResponse = (dispositions: Parameters<typeof respond>[0], a: DecisionAnalysis) => ({ ...respond(dispositions), analysis: a });

const setUp = async (options: TestOptions) => {
  const repo = tempRepo();
  const t = testLayer(repo, options);
  await Effect.runPromise(Effect.gen(function* () {
    yield* (yield* Store).init("the task");
  }).pipe(Effect.provide(t.layer)));
  return t;
};
const loop = (layer: Layer.Layer<Services>) => decisionLoop(FORMAT, "the task", question).pipe(Effect.provide(layer));
const json = (dir: string, name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
const fails = async (layer: Layer.Layer<Services>, tag: RunError["_tag"]): Promise<RunError> => {
  const exit = await Effect.runPromiseExit(loop(layer));
  assert.ok(Exit.isFailure(exit), "the decision loop succeeded");
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(Option.isSome(error), `not a typed failure: ${Cause.pretty(exit.cause)}`);
  assert.equal(error.value._tag, tag);
  return error.value;
};

test("a decision that converges in round 1 writes its records and its checkpoint names the enclosing phase", async () => {
  const { layer, probe } = await setUp({ steps: [{ output: analysis() }], reviews: [{ issues: [] }] });
  const end = await Effect.runPromise(loop(layer));
  assert.deepEqual([end.decision, end.result], [1, "converged"]);
  assert.deepEqual(end.analysis, analysis());
  assert.deepEqual(json(probe.dir, "decision-1/question.json"), { version: 2, decision: 1, ...question });
  assert.deepEqual(json(probe.dir, "decision-1/cc-0.json"), analysis());
  assert.deepEqual(json(probe.dir, "decision-1/analysis.json"), { version: 2, analysis: analysis() });
  assert.deepEqual(json(probe.dir, "decision-1/review-1.json"), { issues: [] });
  assert.equal(json(probe.dir, "decision-1/round-1.json").kind, "no_response");
  const checkpoint = json(probe.dir, "checkpoint.json");
  assert.deepEqual([checkpoint.subject, checkpoint.phase, checkpoint.round, checkpoint.stage], ["decision-1", 1, 1, "reviewed"]);
  // The analysis call carries the format and runs in a fresh session (Q3); the review carries the format.
  assert.ok(probe.planner.prompts[0].includes(FORMAT));
  assert.equal(probe.planner.freshSessions, 1);
  assert.ok(probe.reviewer.prompts[0].includes(FORMAT));
  assert.match(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8"), /## Decision 1\n\nWhich database\?\n\n1\. SQLite — a file\n2\. PostgreSQL — a server/);
});

test("an accepted issue rewrites analysis.json, the log holds D1 ids with the enclosing phase, and round 2 converges", async () => {
  const { layer, probe } = await setUp({
    steps: [{ output: analysis() }, { output: decisionResponse([["D1-R1-1", "accepted"]], analysis("second")) }],
    reviews: [{ issues: [issue("D1-R1-1")] }, { issues: [] }],
  });
  const end = await Effect.runPromise(loop(layer));
  assert.deepEqual([end.result, end.analysis.columns[0].advantages[0].title], ["converged", "second"]);
  assert.equal(json(probe.dir, "decision-1/analysis.json").analysis.columns[0].advantages[0].title, "second");
  assert.deepEqual((await probe.loadLog({ decision: 1 })).map((e) => [e.id, e.phase, e.action]), [["D1-R1-1", 1, "accepted"]]);
  assert.match(probe.reviewer.prompts[1], /D1-R2-1/);
});

test("a disputed issue pauses as in behavior 7", async () => {
  const { layer, probe } = await setUp({
    // The decision on the raised-again issue, then no decision at the idle pause of two cycles without an amendment.
    answers: ["keep it", ""],
    steps: [{ output: analysis() }, { output: decisionResponse([["D1-R1-1", "rejected"]], analysis()) }, { output: decisionResponse([["D1-R1-1", "rejected"]], analysis()) }],
    reviews: [{ issues: [issue("D1-R1-1")] }, { issues: [issue("D1-R1-1")] }, { issues: [] }],
  });
  const end = await Effect.runPromise(loop(layer));
  assert.equal(end.result, "converged");
  assert.ok(probe.ui.asked.some((a) => /issue D1-R1-1, raised again/.test(a)), probe.ui.asked.join("\n"));
  assert.deepEqual((await probe.loadLog({ decision: 1 })).filter((e) => e.source === "user").map((e) => [e.id, e.rationale]), [["D1-R1-1", "keep it"]]);
});

test("0 at the cycle limit halts with RoundLimitStop; p proceeds to the choice", async () => {
  const rejected = { steps: [{ output: analysis() }, { output: decisionResponse([["D1-R1-1", "rejected"]], analysis()) }], reviews: [{ issues: [issue("D1-R1-1")] }], config: { maxRounds: 1 } };
  await fails((await setUp({ ...rejected, answers: ["0"] })).layer, "RoundLimitStop");
  const proceeding = await setUp({ ...rejected, answers: ["p"] });
  assert.equal((await Effect.runPromise(loop(proceeding.layer))).result, "proceed");
  assert.ok(proceeding.probe.ui.asked.some((a) => /proceed to your choice with the analysis as it is/.test(a)));
});

test("an invalid analysis gets one repair turn; a second invalid reply halts", async () => {
  const repaired = await setUp({ steps: [{ output: { columns: 1 } }, { output: analysis() }], reviews: [{ issues: [] }] });
  assert.equal((await Effect.runPromise(loop(repaired.layer))).result, "converged");
  assert.equal(repaired.probe.planner.prompts.length, 2);
  await fails((await setUp({ steps: [{ output: { columns: 1 } }, { output: { columns: 2 } }] })).layer, "AgentReplyInvalid");
});

test("a change of the project during the analysis call halts with ProjectChanged (behavior 3)", async () => {
  await fails((await setUp({ steps: [{ output: analysis(), touchProject: true }] })).layer, "ProjectChanged");
});

test("the initial analysis is validated (P1-R2-1): a missing column halts before any Codex turn; a dangling reference is dropped with a note", async () => {
  const oneColumn = { ...analysis(), columns: [analysis().columns[0]] };
  const halted = await setUp({ steps: [{ output: oneColumn }] });
  await fails(halted.layer, "AnalysisInvalid");
  assert.equal(halted.probe.reviewer.prompts.length, 0);

  const dangling: DecisionAnalysis = { ...analysis(), columns: [{ option: "SQLite", advantages: [entry("E1", "t", [{ id: "A1", text: "But x.", equivalent_to: "E9", replies: [] }])], disadvantages: [] }, analysis().columns[1]] };
  const noted = await setUp({ steps: [{ output: dangling }], reviews: [{ issues: [] }] });
  const end = await Effect.runPromise(loop(noted.layer));
  assert.equal(end.result, "converged");
  assert.equal(json(noted.probe.dir, "decision-1/analysis.json").analysis.columns[0].advantages[0].comparative_condition.counterarguments[0].equivalent_to, "");
  assert.match(fs.readFileSync(path.join(noted.probe.dir, "conversation.md"), "utf8"), /\*\*Reference dropped:\*\* argument A1 names E9, which is no entry of the analysis/);
});

// Decision support, plan step 3.3 (D3): the Decider runs a loop over the run's services, bound to a phase.
test("the Decider of a phase runs a decision loop recorded in that phase", async () => {
  const { layer, probe } = await setUp({ steps: [{ output: analysis() }], reviews: [{ issues: [] }] });
  const outcome = await Effect.runPromise(Effect.gen(function* () {
    const decider = (yield* Decider).at({ kind: "work", n: 2 });
    return yield* decider.decide({ question: question.question, options: question.options });
  }).pipe(Effect.provide(layer)));
  assert.deepEqual([outcome.decision, outcome.result], [1, "converged"]);
  assert.deepEqual(json(probe.dir, "decision-1/question.json").phase, { kind: "work", n: 2 });
  assert.equal(json(probe.dir, "checkpoint.json").phase, 2);
});

// Decision support, plan step 3.4 (D2, P1-R1-3, P1-R1-4): the ask that carries the offer.
const offered = numberedOptions(question.options);
const offering = (layer: Layer.Layer<Services>, q: OfferedQuestion, presented: string[] = [], prompt = "Pick > ") =>
  Effect.runPromise(Effect.gen(function* () {
    const ui = yield* Ui;
    return yield* askOffering((p) => ui.ask(p), prompt, q, Effect.sync(() => void presented.push("present")));
  }).pipe(Effect.provide(layer)));
const analyzed = (probe: { ui: { notified: { _tag: string }[] } }) => probe.ui.notified.filter((e) => e._tag === "DecisionAnalyzed");

test("/decide runs a decision, shows it, restores the presentation and asks again; the answer is recorded as the chosen option", async () => {
  const { layer, probe } = await setUp({ answers: ["/decide", "2"], steps: [{ output: analysis() }], reviews: [{ issues: [] }] });
  const presented: string[] = [];
  assert.equal(await offering(layer, { question: question.question, options: offered }, presented), "2");
  assert.deepEqual(probe.ui.asked, [withOffer("Pick > "), withOffer("Pick > ")]);
  assert.deepEqual(presented, ["present"], "the presentation is restored before the reask, once");
  const shown = analyzed(probe);
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0], { _tag: "DecisionAnalyzed", decision: 1, question: question.question, options: question.options, analysis: analysis() });
  assert.deepEqual(json(probe.dir, "decision-1/chosen.json"), { version: 2, decision: 1, answer: "2", option: "PostgreSQL" });
  assert.match(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8"), /\*\*User choice\*\* after decision 1: 2 \(PostgreSQL\)/);
});

test("free text after an analysis is recorded without an option; q stops and records no choice", async () => {
  const free = await setUp({ answers: ["/decide", "neither, use files"], steps: [{ output: analysis() }], reviews: [{ issues: [] }] });
  assert.equal(await offering(free.layer, { question: question.question, options: offered }), "neither, use files");
  assert.deepEqual(json(free.probe.dir, "decision-1/chosen.json").option, null);
  const quit = await setUp({ answers: ["/decide", "q"], steps: [{ output: analysis() }], reviews: [{ issues: [] }] });
  const exit = await Effect.runPromiseExit(Effect.gen(function* () {
    const ui = yield* Ui;
    return yield* askOffering((p) => ui.ask(p), "Pick > ", { question: question.question, options: offered }, Effect.void);
  }).pipe(Effect.provide(quit.layer)));
  assert.ok(Exit.isFailure(exit));
  assert.ok(!fs.existsSync(path.join(quit.probe.dir, "decision-1/chosen.json")));
});

test("a question with fewer than two options carries no offer and records nothing", async () => {
  const { layer, probe } = await setUp({ answers: ["/decide"] });
  assert.equal(await offering(layer, { question: "q", options: offered.slice(0, 1) }), "/decide");
  assert.deepEqual(probe.ui.asked, ["Pick > "]);
  assert.equal(probe.planner.prompts.length, 0);
});

test("a permission request maps y to Allow and anything else to Deny", async () => {
  const q = { question: "Claude Code requests permission: Bash rm -rf build", options: permissionOptions };
  const permissionAnalysis = { ...analysis(), columns: [{ ...analysis().columns[0], option: "Allow" }, { ...analysis().columns[1], option: "Deny" }] };
  const allow = await setUp({ answers: ["/decide", "y"], steps: [{ output: permissionAnalysis }], reviews: [{ issues: [] }] });
  assert.equal(await offering(allow.layer, q), "y");
  assert.equal(json(allow.probe.dir, "decision-1/chosen.json").option, "Allow");
  const deny = await setUp({ answers: ["/decide", "n"], steps: [{ output: permissionAnalysis }], reviews: [{ issues: [] }] });
  assert.equal(await offering(deny.layer, q), "n");
  assert.equal(json(deny.probe.dir, "decision-1/chosen.json").option, "Deny");
});

test("the cycle limit maps a number to more cycles, p to Proceed where offered, and 0 to Stop", async () => {
  const options = limitOptions("proceed to planning");
  assert.deepEqual(options.map((o) => o.label), [prompts.LIMIT_PROCEED, prompts.LIMIT_STOP, prompts.LIMIT_MORE]);
  const chosen = (answer: string) => options.find((o) => o.matches(answer))?.label;
  assert.deepEqual(["2", "p", "0", "x"].map(chosen), [prompts.LIMIT_MORE, prompts.LIMIT_PROCEED, prompts.LIMIT_STOP, prompts.LIMIT_STOP]);
  const noProceed = limitOptions(null);
  assert.deepEqual(noProceed.map((o) => o.label), [prompts.LIMIT_STOP, prompts.LIMIT_MORE]);
  assert.equal(noProceed.find((o) => o.matches("p"))?.label, prompts.LIMIT_STOP);
  // Numbered options match their number or their label.
  assert.deepEqual(["1", "PostgreSQL", "3", "sqlite"].map((a) => offered.find((o) => o.matches(a))?.label), ["SQLite", "PostgreSQL", undefined, undefined]);
});
