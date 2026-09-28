// The validation of a decision analysis beyond its schema (decision support, D9 of the plan). Pure: no I/O, no Effect
// services. The schema cannot say that the columns are the question's options, that ids are unique, or that a
// reference names an entry; this module does, as src/round.ts does for a round.

import { Result } from "effect";
import { AnalysisInvalid } from "./errors.ts";
import type { Argument, DecisionAnalysis, Element, Entry } from "./schema.ts";

/** A reference (equivalent_to) that named no entry, dropped and treated as no reference. */
export type ReferenceNote = Readonly<{ argument: string; named: string }>;
export type ValidatedAnalysis = Readonly<{ analysis: DecisionAnalysis; notes: readonly ReferenceNote[] }>;

/** The elements of an entry, in the order of docs/decision-making.md. */
export const elementsOf = (entry: Entry): readonly Element[] => [
  entry.comparative_condition,
  entry.starting_cause,
  entry.intermediate_steps,
  entry.threshold,
  entry.effect_on_persons,
  entry.reason_the_effect_matters,
  entry.extent.per_person,
  entry.extent.persons_affected,
  entry.extent.likelihood,
  entry.extent.timing,
];
/** Every entry of the representation, column by column, advantages before disadvantages. */
export const entriesOf = (analysis: DecisionAnalysis): readonly Entry[] => analysis.columns.flatMap((c) => [...c.advantages, ...c.disadvantages]);
// The depth of the replies is that of a value JSON.parse has already built, so plain recursion is as deep as the parse was.
const argumentsOf = (args: readonly Argument[]): readonly Argument[] => args.flatMap((a) => [a, ...argumentsOf(a.replies)]);

const duplicates = (ids: readonly string[]): string[] => [...new Set(ids.filter((id, i) => id !== "" && ids.indexOf(id) !== i))];

/**
 * The analysis checked against the question's options, with every reference that names no entry dropped (a note for
 * each). One column per option, in order, labeled exactly; unique non-empty ids across entries and arguments; a
 * recommendation, when present, names an option. Otherwise AnalysisInvalid.
 */
export const validateAnalysis = (options: readonly Readonly<{ label: string }>[], analysis: DecisionAnalysis): Result.Result<ValidatedAnalysis, AnalysisInvalid> => {
  const expected = options.map((o) => o.label);
  const got = analysis.columns.map((c) => c.option);
  const columnsMatch = expected.length === got.length && expected.every((label, i) => label === got[i]);
  const entries = entriesOf(analysis);
  const args = entries.flatMap((e) => elementsOf(e).flatMap((el) => argumentsOf(el.counterarguments)));
  const ids = [...entries.map((e) => e.id), ...args.map((a) => a.id)];
  const recommended = analysis.recommendation.option;
  const problems = {
    columns: columnsMatch ? null : { expected, got },
    duplicateIds: duplicates(ids),
    emptyIds: ids.filter((id) => id === "").length,
    recommendation: recommended !== "" && !expected.includes(recommended) ? recommended : null,
  };
  if (problems.columns !== null || problems.duplicateIds.length > 0 || problems.emptyIds > 0 || problems.recommendation !== null) return Result.fail(new AnalysisInvalid(problems));

  const entryIds = new Set(entries.map((e) => e.id));
  const notes: ReferenceNote[] = args.filter((a) => a.equivalent_to !== "" && !entryIds.has(a.equivalent_to)).map((a) => ({ argument: a.id, named: a.equivalent_to }));
  if (notes.length === 0) return Result.succeed({ analysis, notes });
  const fixArgument = (a: Argument): Argument => ({ ...a, equivalent_to: entryIds.has(a.equivalent_to) ? a.equivalent_to : "", replies: a.replies.map(fixArgument) });
  const fixElement = (el: Element): Element => ({ ...el, counterarguments: el.counterarguments.map(fixArgument) });
  const fixEntry = (e: Entry): Entry => ({
    ...e,
    comparative_condition: fixElement(e.comparative_condition),
    starting_cause: fixElement(e.starting_cause),
    intermediate_steps: fixElement(e.intermediate_steps),
    threshold: fixElement(e.threshold),
    effect_on_persons: fixElement(e.effect_on_persons),
    reason_the_effect_matters: fixElement(e.reason_the_effect_matters),
    extent: { per_person: fixElement(e.extent.per_person), persons_affected: fixElement(e.extent.persons_affected), likelihood: fixElement(e.extent.likelihood), timing: fixElement(e.extent.timing) },
  });
  const fixed: DecisionAnalysis = { ...analysis, columns: analysis.columns.map((c) => ({ ...c, advantages: c.advantages.map(fixEntry), disadvantages: c.disadvantages.map(fixEntry) })) };
  return Result.succeed({ analysis: fixed, notes });
};
