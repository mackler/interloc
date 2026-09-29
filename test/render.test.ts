import assert from "node:assert/strict";
import { test } from "node:test";
import { analysisLines, interviewSays, recordHeading, renderDecision, renderResponse, renderReview, renderFeedback, renderQuestions, renderRound, subjectHeading } from "../src/render.ts";
import { issue, respond } from "./helpers.ts";
import { viewOf } from "../src/analysisView.ts";
import type { Argument, DecisionAnalysis, Entry, LogEntry } from "../src/schema.ts";
import { OPPOSES_MARKER } from "../src/prompts.ts";
import * as prompts from "../src/prompts.ts";

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
  const list = { questions: [{ id: "Q1", context: "c", question: "A or B?", reason: "r", proposed_answers: [{ label: "A", description: "a" }, { label: "B", description: "b" }], default_answer: "B" }] };
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
  // W1-R1-2: texts of several lines, opposing and not: every physical line is checked.
  const chain = (p: string): Argument[] => [{ id: `${p}1`, text: `${p} one.\n${p} one, continued.`, equivalent_to: "", replies: [{ id: `${p}2`, text: `${p} two.\n${p} two, continued.`, equivalent_to: "", replies: [{ id: `${p}3`, text: `${p} three.`, equivalent_to: "", replies: [] }] }] }];
  const multiline = (e: Entry): Entry => ({ ...e, title: `${e.title}\nTitle continued.`, comparative_condition: { ...e.comparative_condition, text: `${e.comparative_condition.text}\nElement continued.` } });
  const analysis: DecisionAnalysis = {
    decision: "d",
    columns: [
      { kind: "argued", option: "SQLite", advantages: [multiline(entry("E1", chain("a")))], disadvantages: [multiline(entry("E2", chain("d")))] },
      { kind: "unclear", option: "PostgreSQL", unclear: "It could mean a server\nor a hosted service." },
    ],
    recommendation: { option: "", reason: "" },
  };
  const view = viewOf(analysis);
  const marked = (text: string, symbol: string | null) => (symbol === null ? text : `${text} ${symbol}`);
  // Each item's physical lines, as [indentation, the text after the marker, opposes]: a bullet's continuation lines are
  // indented past its "- ", and every line of an opposing text carries the marker after the indentation.
  const physical = (indent: number, prefix: string, text: string, opposes: boolean) =>
    text.split("\n").map((part, i) => [indent, `${i === 0 ? prefix : " ".repeat(prefix.length)}${part}`, opposes] as const);
  const expected = view.columns.flatMap((c) =>
    c.kind === "unclear"
      ? physical(2, "", c.unclear, false)
      : [...c.advantages, ...c.disadvantages].flatMap((e) => [
          ...physical(2, "", `${e.label} ${marked(e.title, e.symbol)}`, e.opposes),
          ...e.elements.flatMap((x) => [...physical(4, "- ", x.text, x.opposes), ...x.arguments.flatMap((a) => physical(6 + 2 * a.level, "", marked(a.text, a.symbol), a.opposes))]),
        ]),
  );
  const lines = analysisLines(1, "Which?", view);
  const rendered = ([indent, text, opposes]: readonly [number, string, boolean]) => `${" ".repeat(indent)}${opposes ? OPPOSES_MARKER : ""}${text}`;
  const items = lines.filter((l) => l !== "" && !/^(Decision|Option) \d/.test(l) && l.trim() !== "Advantages:" && l.trim() !== "Disadvantages:");
  assert.deepEqual(items, expected.map(rendered));
  assert.ok(expected.some(([, , opposes]) => opposes));
  assert.ok(expected.some(([, text]) => text.startsWith("  ")), "a bullet's continuation line is in the fixture");
  const unclear = lines.indexOf("Option 2: PostgreSQL");
  assert.deepEqual(lines.slice(unclear, unclear + 4), ["Option 2: PostgreSQL", "", "  It could mean a server", "  or a hosted service."]);
});

// S8: every question is printed in the one shape: heading with its number, the line saying where it came from, the
// context set apart and indented, the terms, the question itself apart from the context, the options with their answers.
test("questionLines prints the heading, the origin, the context, the terms, the question and the options, in that order", async () => {
  const { questionLines } = await import("../src/render.ts");
  const q = {
    number: 4,
    origin: { kind: "relayed" as const },
    context: { text: "Claude Code, the coding agent, is writing the tool's input check.", by: "agent" as const },
    terms: [{ term: "zod", explanation: "a library that checks the shape of data" }],
    question: "Should zod be declared as a dependency?",
    options: [
      { label: "Declare it", description: "add it to package.json", answer: { token: "1" } },
      { label: "More cycles", description: "", answer: { numeric: true as const } },
    ],
    details: "",
    decision: null,
  };
  const lines = questionLines(q);
  const at = (text: string) => lines.findIndex((l) => l.includes(text));
  assert.equal(lines.find((l) => l.trim() !== ""), prompts.questionTitle(4));
  const order = [prompts.originLine(q.origin, null).slice(0, 30), q.context.text, prompts.TERMS_HEADING, "zod: a library", q.question, "1. Declare it — add it to package.json", "More cycles (type the number)"].map(at);
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), JSON.stringify({ order, lines }));
  // The context is indented and set apart by blank lines; the question is not indented.
  assert.match(lines[at(q.context.text)], /^ {4}\S/);
  assert.equal(lines[at(q.context.text) - 1], "");
  assert.equal(lines[at(q.question)], q.question);
  assert.equal(lines[at(q.question) - 1], "");
  // S11: what the question is about follows the context, before the terms and the question.
  const withDetails = questionLines({ ...q, details: "Codex says: the migration is missing." });
  const d = withDetails.findIndex((l) => l.includes("Codex says"));
  assert.ok(d > withDetails.findIndex((l) => l.includes(q.context.text)) && d < withDetails.findIndex((l) => l.includes(prompts.TERMS_HEADING)));
  // A context the program wrote is marked as the program's.
  assert.ok(questionLines({ ...q, context: { text: "x", by: "program" } }).some((l) => l.includes(prompts.CONTEXT_BY_PROGRAM)));
  assert.ok(!lines.some((l) => l.includes(prompts.CONTEXT_BY_PROGRAM)));
});

test("a question inside a decision says in its origin line that it belongs to that decision and why it is asked (issue #57)", () => {
  const line = prompts.originLine({ kind: "planner", heading: "Decision 2" }, 2);
  assert.match(line, /Decision 2/);
  assert.match(line, new RegExp(prompts.HELP_ME_DECIDE));
  assert.match(line, /undetermined/);
  assert.doesNotMatch(prompts.originLine({ kind: "planner", heading: "Planning 1" }, null), /belongs to Decision/);
});

test("conversation.md records a question under its displayed number with the record's id beside it (S6)", async () => {
  const { renderQuestionRecord } = await import("../src/render.ts");
  const q = { number: 3, origin: { kind: "clarification" as const, id: "Q1" }, context: { text: "c", by: "agent" as const }, terms: [], question: "Which?", options: [], details: "", decision: null };
  assert.match(renderQuestionRecord(q), /^### Question 3 \(Q1\)\n/);
  assert.match(renderQuestionRecord({ ...q, origin: { kind: "relayed" } }), /^### Question 3\n/);
  assert.match(renderQuestionRecord({ ...q, origin: { kind: "pause", heading: "Planning phase 1", pause: "reraised", id: "P1-R1-2" } }), /^### Question 3 \(P1-R1-2\)\n/);
});

// S11 (issue #19): a pause's facts are prose, never JSON: the issue's problem and evidence, each earlier disposition
// and its rationale in words, and no empty fields.
test("pauseProse writes every kind of pause as prose, without the record's field names or empty fields", async () => {
  const { pauseProse } = await import("../src/render.ts");
  const earlier = [
    { id: "P1-R1-1", phase: 1, round: 1, source: "review" as const, severity: "major" as const, location: "S3", problem: "The plan omits the migration.", evidence: "Step S3 writes the table\nbut never migrates it.", action: "rejected" as const, rationale: "The migration is in S4.", duplicate_of: null, reverses: null, superseded: true },
    { id: "P1-R1-1", phase: 1, round: 2, source: "user" as const, problem: "The plan omits the migration.", action: "decided_by_user" as const, rationale: "Add it to S3.", superseded: false },
  ] as unknown as LogEntry[];
  const issueNow = { id: "P1-R2-1", severity: "major" as const, location: "S3", problem: "Still no migration.", evidence: "S3 is unchanged." };
  const disposition = { id: "P1-R2-1", action: "partially_accepted" as const, rationale: "Only the index.", duplicate_of: "", reverses: "" };
  const all = [
    pauseProse({ pause: "reraised", id: "P1-R1-1", history: earlier, issue: issueNow }),
    pauseProse({ pause: "secondClarification", id: "P1-R1-1", history: earlier, disposition }),
    pauseProse({ pause: "disputedSelfCorrection", id: "P1-R1-1", explanation: "It breaks the build.", history: earlier }),
    pauseProse({ pause: "reversal", id: "P1-R2-1", reverses: "P1-R1-1", history: earlier, issue: issueNow, disposition }),
    pauseProse({ pause: "repeatedUnderNewId", id: "P1-R2-1", repeats: "P1-R1-1", history: earlier, issue: issueNow }),
    pauseProse({ pause: "unexplained", fileLabel: "plan.json", heading: "Planning phase 1", round: 2, resultText: "I tidied it." }),
    pauseProse({ pause: "identical", fileLabel: "plan.json", round: 3, seen: "cycle 1" }),
    pauseProse({ pause: "idle", idle: 2, round: 2, issues: [earlier[0]] }),
  ];
  for (const text of all) {
    assert.ok(text.trim() !== "");
    for (const forbidden of ["{", "duplicate_of", "reverses:", "superseded", "\\n", "null", "decided_by_user", "partially_accepted"]) assert.ok(!text.includes(forbidden), `${forbidden} in: ${text}`);
  }
  assert.match(all[0], /The plan omits the migration\./);
  assert.match(all[0], /Codex says: Still no migration\.\n\nS3 is unchanged\./);
  assert.match(all[0], /Codex raised it: The plan omits the migration\. — Claude Code rejected it: The migration is in S4\./);
  assert.match(all[0], /you decided: Add it to S3\./);
  assert.match(all[1], /accepted it in part: Only the index\./);
  assert.match(all[5], /I tidied it\./);
});
