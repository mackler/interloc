import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { validateAnalysis } from "../src/analysis.ts";
import { AnalysisInvalid, haltMessage } from "../src/errors.ts";
import type { Argument, DecisionAnalysis, Entry } from "../src/schema.ts";

// Decision support, plan step 2.3 (D9): what the schema cannot check.
const el = (text = "t", counterarguments: Entry["threshold"]["counterarguments"] = []) => ({ text, counterarguments });
const entry = (id: string, counter: Entry["threshold"]["counterarguments"] = []): Entry => ({
  id,
  title: `title ${id}`,
  comparative_condition: el("c", counter),
  starting_cause: el(),
  intermediate_steps: el(),
  threshold: el(),
  effect_on_persons: el(),
  reason_the_effect_matters: el(),
  extent: { per_person: el(), persons_affected: el(), likelihood: el(), timing: el() },
});
const arg = (id: string, equivalent_to = "", replies: Argument[] = []): Argument => ({ id, text: `But ${id}.`, equivalent_to, replies });
const options = [{ label: "A", description: "a" }, { label: "B", description: "b" }];
const analysis = (over: Partial<DecisionAnalysis> = {}): DecisionAnalysis => ({
  decision: "d",
  columns: [
    { option: "A", advantages: [entry("E1", [arg("A1", "", [arg("A2", "", [arg("A3", "E2")])])])], disadvantages: [] },
    { option: "B", advantages: [], disadvantages: [entry("E2")] },
  ],
  recommendation: { option: "", reason: "" },
  ...over,
});
const failure = (r: ReturnType<typeof validateAnalysis>): AnalysisInvalid => {
  assert.ok(Result.isFailure(r), "the analysis was accepted");
  return r.failure;
};

test("a valid analysis passes unchanged, with no notes", () => {
  const r = validateAnalysis(options, analysis());
  assert.ok(Result.isSuccess(r));
  assert.deepEqual(r.success.analysis, analysis());
  assert.deepEqual(r.success.notes, []);
});

test("one column per option, in the question's order, with the option's label", () => {
  assert.deepEqual(failure(validateAnalysis(options, analysis({ columns: [analysis().columns[0]] }))).columns, { expected: ["A", "B"], got: ["A"] });
  assert.deepEqual(failure(validateAnalysis(options, analysis({ columns: [analysis().columns[1], analysis().columns[0]] }))).columns, { expected: ["A", "B"], got: ["B", "A"] });
  assert.deepEqual(failure(validateAnalysis(options, analysis({ columns: [analysis().columns[0], { ...analysis().columns[1], option: "b" }] }))).columns, { expected: ["A", "B"], got: ["A", "b"] });
});

test("entry and argument ids are unique and non-empty across the representation", () => {
  const dup = analysis({ columns: [{ option: "A", advantages: [entry("E1", [arg("E2")])], disadvantages: [] }, { option: "B", advantages: [], disadvantages: [entry("E2")] }] });
  assert.deepEqual(failure(validateAnalysis(options, dup)).duplicateIds, ["E2"]);
  const empty = analysis({ columns: [{ option: "A", advantages: [entry("")], disadvantages: [] }, { option: "B", advantages: [], disadvantages: [entry("E2", [arg("")])] }] });
  assert.equal(failure(validateAnalysis(options, empty)).emptyIds, 2);
});

test("a reference to no entry is dropped with a note; a reference to an argument is no entry either", () => {
  const dangling = analysis({ columns: [{ option: "A", advantages: [entry("E1", [arg("A1", "", [arg("A2", "E9")])])], disadvantages: [] }, { option: "B", advantages: [], disadvantages: [entry("E2", [arg("A3", "A1")])] }] });
  const r = validateAnalysis(options, dangling);
  assert.ok(Result.isSuccess(r));
  assert.deepEqual(r.success.notes, [{ argument: "A2", named: "E9" }, { argument: "A3", named: "A1" }]);
  assert.equal(r.success.analysis.columns[0].advantages[0].comparative_condition.counterarguments[0].replies[0].equivalent_to, "");
  assert.equal(r.success.analysis.columns[1].disadvantages[0].comparative_condition.counterarguments[0].equivalent_to, "");
});

test("a recommendation names one of the options or is empty", () => {
  assert.ok(Result.isSuccess(validateAnalysis(options, analysis({ recommendation: { option: "B", reason: "because" } }))));
  assert.equal(failure(validateAnalysis(options, analysis({ recommendation: { option: "C", reason: "because" } }))).recommendation, "C");
});

test("AnalysisInvalid is described for the user", () => {
  const error = new AnalysisInvalid({ columns: { expected: ["A", "B"], got: ["A"] }, duplicateIds: ["E2"], emptyIds: 1, recommendation: "C" });
  const text = haltMessage(error) ?? "";
  assert.match(text, /^HALTED: the decision analysis is invalid: /);
  assert.match(text, /columns A, B expected, A given/);
  assert.match(text, /E2/);
  assert.match(text, /1 empty id/);
  assert.match(text, /recommends C, which is not an option/);
});
