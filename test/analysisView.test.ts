import assert from "node:assert/strict";
import { test } from "node:test";
import { symbolFor, viewOf } from "../src/analysisView.ts";
import * as prompts from "../src/prompts.ts";
import type { Argument, DecisionAnalysis, Entry } from "../src/schema.ts";

// Decision support, plan step 4.1 (D8): the renderer owns the heading, the offsets and the symbols.
const el = (text: string, counterarguments: Argument[] = []) => ({ text, counterarguments });
const entry = (id: string, counter: Argument[] = []): Entry => ({
  id,
  title: `Title ${id}.`,
  comparative_condition: el(`c ${id}`, counter),
  starting_cause: el(`s ${id}`),
  intermediate_steps: el(`i ${id}`),
  threshold: el(`t ${id}`),
  effect_on_persons: el(`e ${id}`),
  reason_the_effect_matters: el(`r ${id}`),
  extent: { per_person: el(`pp ${id}`), persons_affected: el(`pa ${id}`), likelihood: el(`l ${id}`), timing: el(`w ${id}`) },
});
const arg = (id: string, equivalent_to = "", replies: Argument[] = []): Argument => ({ id, text: `text ${id}`, equivalent_to, replies });

test("symbols run *, †, ‡, §, ‖, ¶, then doubled, then tripled", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(symbolFor), ["*", "†", "‡", "§", "‖", "¶"]);
  assert.equal(symbolFor(6), "**");
  assert.equal(symbolFor(11), "¶¶");
  assert.equal(symbolFor(12), "***");
});

test("columns in order; each entry's elements in the document's order; arguments with their levels and symbols", () => {
  const analysis: DecisionAnalysis = {
    decision: "d",
    columns: [
      { option: "A", advantages: [entry("E1", [arg("A1", "", [arg("A2", "", [arg("A3", "E3")])])])], disadvantages: [entry("E2")] },
      { option: "B", advantages: [entry("E3", [arg("A4", "E2")])], disadvantages: [entry("E4")] },
    ],
    recommendation: { option: "", reason: "" },
  };
  const view = viewOf(analysis);
  assert.deepEqual(view.columns.map((c) => c.option), ["A", "B"]);
  assert.equal(view.columns[0].disadvantagesHeading, prompts.DISADVANTAGES_HEADING);
  assert.equal(prompts.DISADVANTAGES_HEADING, "Disadvantages:");
  const e1 = view.columns[0].advantages[0];
  assert.deepEqual(e1.elements.map((x) => x.text), ["c E1", "s E1", "i E1", "t E1", "e E1", "r E1", "pp E1", "pa E1", "l E1", "w E1"]);
  assert.deepEqual(e1.elements[0].arguments.map((a) => [a.id, a.level, a.symbol]), [["A1", 1, null], ["A2", 2, null], ["A3", 3, "†"]]);
  // E2 (first referenced in column order) gets *, E3 gets †; unreferenced entries get none.
  assert.deepEqual(view.columns.flatMap((c) => [...c.advantages, ...c.disadvantages]).map((e) => [e.id, e.symbol]), [["E1", null], ["E2", "*"], ["E3", "†"], ["E4", null]]);
  assert.equal(view.columns[1].advantages[0].elements[0].arguments[0].symbol, "*");
  assert.equal(view.recommendation, null);
});

test("a column without disadvantages still shows the heading; a recommendation is shown when present", () => {
  const view = viewOf({ decision: "d", columns: [{ option: "A", advantages: [entry("E1")], disadvantages: [] }], recommendation: { option: "A", reason: "because" } });
  assert.equal(view.columns[0].disadvantagesHeading, "Disadvantages:");
  assert.deepEqual(view.columns[0].disadvantages, []);
  assert.deepEqual(view.recommendation, { option: "A", reason: "because" });
});
