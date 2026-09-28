// The validation of a decision analysis beyond its schema (decision support, D9 of the plan). Pure: no I/O, no Effect
// services. The schema cannot say that the columns are the question's options, that ids are unique, or that a
// reference names an entry; this module does, as src/round.ts does for a round.

import { Result } from "effect";
import { AnalysisInvalid } from "./errors.ts";
import { elementsOf, entriesOf, flatten } from "./analysisView.ts";
import type { Argument, DecisionAnalysis, Element, Entry } from "./schema.ts";

/**
 * What the validation corrected: a reference (equivalent_to) that named no entry, dropped and treated as no reference; or
 * an option label that matched only after normalization, rewritten to the exact label (issue #37, decision Q4).
 */
export type AnalysisNote = Readonly<{ kind: "reference"; argument: string; named: string }> | Readonly<{ kind: "label"; given: string; exact: string }>;
export type ValidatedAnalysis = Readonly<{ analysis: DecisionAnalysis; notes: readonly AnalysisNote[] }>;

/** A label as the tolerant comparison sees it: one leading `<n>.` or `<n>)` dropped, whitespace collapsed (issue #37). */
export const normalizeLabel = (label: string): string =>
  label
    .replace(/^\s*\d+[.)]/, "")
    .split(/\s+/)
    .filter((w) => w !== "")
    .join(" ");

/** The exact label a given one stands for: itself when exact, the one option it matches after normalization, or none. */
const resolveLabel = (candidates: readonly string[], given: string): Readonly<{ exact: string | null; matches: readonly string[] }> => {
  if (candidates.includes(given)) return { exact: given, matches: [given] };
  const matches = candidates.filter((label) => normalizeLabel(label) === normalizeLabel(given));
  return { exact: matches.length === 1 ? matches[0] : null, matches };
};

const argumentsOf = (args: readonly Argument[]): readonly Argument[] => flatten(args);

const duplicates = (ids: readonly string[]): string[] => [...new Set(ids.filter((id, i) => id !== "" && ids.indexOf(id) !== i))];

/**
 * The analysis checked against the question's options, with every reference that names no entry dropped (a note for
 * each). One column per option, in order, labeled exactly or after normalization (then rewritten, with a note); unique non-empty ids across entries and arguments; a
 * recommendation, when present, names an option. Otherwise AnalysisInvalid.
 */
export const validateAnalysis = (options: readonly Readonly<{ label: string }>[], analysis: DecisionAnalysis): Result.Result<ValidatedAnalysis, AnalysisInvalid> => {
  const expected = options.map((o) => o.label);
  const got = analysis.columns.map((c) => c.option);
  // Columns by position: each has one candidate, its own option's label (an exact match first, G-R1-1).
  const columnLabels = got.map((label, i) => (i < expected.length ? resolveLabel([expected[i]], label).exact : null));
  const columnsMatch = expected.length === got.length && columnLabels.every((label) => label !== null);
  const entries = entriesOf(analysis);
  const args = entries.flatMap((e) => elementsOf(e).flatMap((el) => argumentsOf(el.counterarguments)));
  const ids = [...entries.map((e) => e.id), ...args.map((a) => a.id)];
  const recommended = analysis.recommendation.option;
  const recommendation = recommended === "" ? { exact: "", matches: [] } : resolveLabel(expected, recommended);
  const problems = {
    columns: columnsMatch ? null : { expected, got },
    duplicateIds: duplicates(ids),
    emptyIds: ids.filter((id) => id === "").length,
    recommendation: recommendation.exact === null ? { given: recommended, matches: recommendation.matches } : null,
  };
  if (problems.columns !== null || problems.duplicateIds.length > 0 || problems.emptyIds > 0 || problems.recommendation !== null) return Result.fail(new AnalysisInvalid(problems));

  const exactColumns = columnLabels as readonly string[];
  const exactRecommendation = recommendation.exact as string;
  const labelNotes: AnalysisNote[] = [
    ...got.flatMap((label, i) => (label === exactColumns[i] ? [] : [{ kind: "label" as const, given: label, exact: exactColumns[i] }])),
    ...(recommended === exactRecommendation ? [] : [{ kind: "label" as const, given: recommended, exact: exactRecommendation }]),
  ];
  const labeled: DecisionAnalysis =
    labelNotes.length === 0
      ? analysis
      : { ...analysis, columns: analysis.columns.map((c, i) => ({ ...c, option: exactColumns[i] })), recommendation: { ...analysis.recommendation, option: exactRecommendation } };
  const entryIds = new Set(entries.map((e) => e.id));
  const referenceNotes: AnalysisNote[] = args.filter((a) => a.equivalent_to !== "" && !entryIds.has(a.equivalent_to)).map((a) => ({ kind: "reference", argument: a.id, named: a.equivalent_to }));
  const notes = [...labelNotes, ...referenceNotes];
  if (referenceNotes.length === 0) return Result.succeed({ analysis: labeled, notes });
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
  const fixed: DecisionAnalysis = { ...labeled, columns: labeled.columns.map((c) => ({ ...c, advantages: c.advantages.map(fixEntry), disadvantages: c.disadvantages.map(fixEntry) })) };
  return Result.succeed({ analysis: fixed, notes });
};
