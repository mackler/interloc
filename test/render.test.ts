import assert from "node:assert/strict";
import { test } from "node:test";
import { analysisLines, interviewSays, recordHeading, renderDecision, renderResponse, renderReview, renderFeedback, renderQuestions, renderRound, subjectHeading } from "../src/render.ts";
import { issue, respond } from "./helpers.ts";
import { viewOf } from "../src/analysisView.ts";
import type { Argument, DecisionAnalysis, Entry } from "../src/schema.ts";
import { OPPOSES_MARKER } from "../src/prompts.ts";

// Finding 27 / recommendation D: the Store writes; the text of the records is composed here.
test("subject headings", () => {
  assert.deepEqual([subjectHeading("questions"), subjectHeading("requirements"), subjectHeading({ plan: 3 })], ["Question review", "Requirements review", "Planning phase 3"]);
});

test("renderRound lists the issues, the dispositions with their references, the self-corrections and the feedback", () => {
  const review = { issues: [issue("A"), issue("B")] };
  const base = respond([["A", "accepted"], ["B", "rejected"]]);
  const response = {
    ...base,
    dispositions: base.dispositions.map((d) => (d.id === "B" ? { ...d, duplicate_of: "A" } : d)),
    self_corrections: [{ id: "C", new_action: "plan_error" as const, explanation: "oops" }],
    reviewer_feedback: "be brief",
  };
  const text = renderRound("Planning phase 1", 2, review, response);
  assert.match(text, /^## Planning phase 1, round 2\n\n### Codex\n\n- \*\*\[A\]\*\* /);
  assert.match(text, /### Claude Code\n\n- \*\*\[A\]\*\* accepted: rationale A\n- \*\*\[B\]\*\* rejected \(duplicate of A\): rationale B\n- \*\*Self-correction\*\* \(plan_error, issue "C"\): oops\n- \*\*Feedback to the reviewer:\*\* be brief\n\n$/);
});

test("renderDecision gives the record line and the conversation line of one decision event", () => {
  const lines = renderDecision({ subject: "issue A, raised again", id: null, decision: "keep it", phase: 1, round: 2 });
  assert.equal(lines.record, "Subject: issue A, raised again\nDecision: keep it\n\n");
  assert.equal(lines.conversation, "**User decision** on issue A, raised again: keep it\n\n");
});

test("renderFeedback and renderQuestions", () => {
  assert.equal(renderFeedback("Planning phase 1", 2, "too strict"), "## Planning phase 1, round 2\ntoo strict\n\n");
  assert.equal(renderQuestions({ questions: [] }), "The list is empty.\n");
  const list = { questions: [{ id: "Q1", question: "A or B?", reason: "r", proposed_answers: [{ label: "A", description: "a" }, { label: "B", description: "b" }], default_answer: "B" }] };
  assert.equal(renderQuestions(list), "- **[Q1]** A or B?\n  Reason: r\n  - A: a\n  - B: b (default)\n");
  assert.match(renderQuestions({ questions: [{ ...list.questions[0], default_answer: null }] }), /- B: b\n$/);
});

// Plan step 1.5: the terminal lines of an interview turn, shared with the page's reducer (4.2).
test("interviewSays gives the terminal lines of a continuing turn and of a proposed summary", () => {
  assert.deepEqual(interviewSays({ kind: "continuing", message: "Hello" }), ["\nHello\n"]);
  assert.deepEqual(interviewSays({ kind: "summary_proposed", message: "Done.", summary: "# R" }), ["\nDone.\n", "Summary proposed by Claude Code:\n\n# R\n"]);
});

// Plan step 1.6: the page shows the two halves of a round as two messages; conversation.md keeps the whole.
test("renderRound is the heading followed by renderReview and renderResponse", () => {
  const review = { issues: [issue("A"), issue("B")] };
  const response = respond([["A", "accepted"], ["B", "rejected"]], { reviewer_feedback: "thanks" });
  assert.equal(renderRound("Planning phase 1", 2, review, response), "## Planning phase 1, round 2\n\n" + renderReview(review) + renderResponse(response));
  assert.match(renderReview(review), /^### Codex\n\n- \*\*\[A\]\*\*/);
  assert.match(renderResponse(response), /^### Claude Code\n\n- \*\*\[A\]\*\* accepted/);
});

test("the heading of a work review", () => {
  assert.equal(subjectHeading({ work: 2 }), "Work review 2");
});

// The records keep their headings when the user-facing name becomes "clarification" (issue #21, Q5 follow-up).
test("conversation.md's headings of the interviews are unchanged", () => {
  assert.equal(recordHeading("clarification"), "Interview");
  assert.equal(recordHeading("followUp"), "Second interview");
  assert.equal(recordHeading("conversation"), "Conversation before planning");
});

// Decision support, plan step 5.1: the terminal shows each option's arguments one after another.
test("analysisLines: each option in turn, Disadvantages:, arguments indented by level, symbols, the recommendation", () => {
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
  const analysis: DecisionAnalysis = {
    decision: "d",
    columns: [
      { kind: "argued", option: "SQLite", advantages: [entry("E1", [{ id: "A1", text: "But x.", equivalent_to: "", replies: [{ id: "A2", text: "On the other hand y.", equivalent_to: "E2", replies: [] }] }])], disadvantages: [] },
      { kind: "argued", option: "PostgreSQL", advantages: [], disadvantages: [entry("E2")] },
    ],
    recommendation: { option: "SQLite", reason: "It is sooner." },
  };
  const lines = analysisLines(2, "Which database?", viewOf(analysis));
  const m = OPPOSES_MARKER;
  assert.deepEqual(lines.slice(0, 11), ["", "Decision 2: Which database?", "", "Option 1: SQLite", "", "  Advantages:", "", "  Advantage 1: Title E1.", "    - c E1", `        ${m}But x.`, "          On the other hand y. *"]);
  const second = lines.indexOf("Option 2: PostgreSQL");
  assert.ok(second > 0);
  assert.equal(lines.filter((l) => l === "  Advantages:").length, 2);
  assert.equal(lines.filter((l) => l === "  Disadvantages:").length, 2);
  assert.ok(lines.includes(`  ${m}Disadvantage 1: Title E2. *`));
  assert.ok(lines.includes(`    ${m}- c E2`));
  assert.deepEqual(lines.slice(-3), ["", "Recommended option: SQLite", "It is sooner."]);
});

// Issue #35 (Q9): the terminal marks exactly the texts the page colors, both derived from the view of one analysis.
test("analysisLines marks exactly the texts that oppose the column's option, and an unclear column shows its statement", () => {
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
  const chain = (p: string): Argument[] => [{ id: `${p}1`, text: `${p} one.`, equivalent_to: "", replies: [{ id: `${p}2`, text: `${p} two.`, equivalent_to: "", replies: [{ id: `${p}3`, text: `${p} three.`, equivalent_to: "", replies: [] }] }] }];
  const analysis: DecisionAnalysis = {
    decision: "d",
    columns: [
      { kind: "argued", option: "SQLite", advantages: [entry("E1", chain("a"))], disadvantages: [entry("E2", chain("d"))] },
      { kind: "unclear", option: "PostgreSQL", unclear: "It could mean a server or a hosted service." },
    ],
    recommendation: { option: "", reason: "" },
  };
  const view = viewOf(analysis);
  const marked = (text: string, symbol: string | null) => (symbol === null ? text : `${text} ${symbol}`);
  const expected = view.columns.flatMap((c) =>
    c.kind === "unclear"
      ? []
      : [...c.advantages, ...c.disadvantages].flatMap((e) => [
          [`${e.label} ${marked(e.title, e.symbol)}`, e.opposes],
          ...e.elements.flatMap((x) => [[`- ${x.text}`, x.opposes], ...x.arguments.map((a) => [marked(a.text, a.symbol), a.opposes])]),
        ]),
  );
  const lines = analysisLines(1, "Which?", view);
  const items = lines
    .map((l) => l.trimStart())
    .filter((l) => l !== "" && !/^(Decision|Option) \d/.test(l) && l !== "Advantages:" && l !== "Disadvantages:" && l !== "It could mean a server or a hosted service.")
    .map((l) => (l.startsWith(OPPOSES_MARKER) ? [l.slice(OPPOSES_MARKER.length), true] : [l, false]));
  assert.deepEqual(items, expected);
  assert.ok(expected.some(([, opposes]) => opposes));
  const unclear = lines.indexOf("Option 2: PostgreSQL");
  assert.deepEqual(lines.slice(unclear, unclear + 3), ["Option 2: PostgreSQL", "", "  It could mean a server or a hosted service."]);
});
