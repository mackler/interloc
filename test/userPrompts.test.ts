import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { parseAskLine, parseMessage } from "../src/input.ts";
import * as prompts from "../src/prompts.ts";
import { HINTS, numberedChoices, numberedOptionLabels, promptOf, type UserPrompt } from "../src/userPrompts.ts";
import { NUMBERED_MESSAGE } from "./interviewFixture.ts";

const quits = (p: UserPrompt, sends: string): boolean => (p.mode === "ask" ? parseAskLine(sends).kind === "quit" : parseMessage(sends).kind === "quit");
const labels = (p: UserPrompt): string[] => p.choices.map((c) => `${c.label}=${c.sends}`);

// Every text of the catalog, with the entry it must map to. S8: the options of a question (a pause's positions, the
// limit's proceed and stop, a permission's allow and deny) come with the question, not with the prompt text.
const catalog: [string, Partial<UserPrompt> & { kind: UserPrompt["kind"] }, string[]][] = [
  [prompts.decisionPrompt, { kind: "decision", mode: "ask", free: "line" }, ["No decision=", "Quit=q"]],
  [prompts.limitPrompt, { kind: "limit", mode: "ask", free: "line" }, ["Quit=q"]],
  [prompts.limitNoProceedPrompt, { kind: "limitNoProceed", mode: "ask", free: "line" }, ["Quit=q"]],
  [prompts.unchangedPrompt, { kind: "unchanged", mode: "ask", free: "none" }, ["Quit=q"]],
  [prompts.transportPrompt, { kind: "transport", mode: "ask", free: "none" }, ["Quit=q"]],
  [prompts.execInputPrompt, { kind: "execInput", mode: "ask", free: "line" }, ["Quit=q"]],
  [prompts.optionOrTextPrompt, { kind: "optionOrText", mode: "ask", free: "line" }, ["Quit=q"]],
  [prompts.permissionPrompt, { kind: "permission", mode: "ask", free: "none" }, ["Quit=q"]],
  [prompts.interviewMessagePrompt, { kind: "interviewMessage", mode: "message", free: "message" }, ["End clarification=/done", "Quit=/quit"]],
  [prompts.confirmSummaryPrompt, { kind: "confirmSummary", mode: "message", free: "message" }, ["Confirm=", "Quit=/quit"]],
  [prompts.startOrTalkPrompt, { kind: "startOrTalk", mode: "message", free: "message" }, ["Start planning=", "Quit=/quit"]],
];

for (const [text, expected, choices] of catalog) {
  test(`promptOf maps the ${expected.kind} text to its widget`, () => {
    const p = promptOf(text);
    assert.equal(p.kind, expected.kind);
    for (const [key, value] of Object.entries(expected)) assert.equal(p[key as keyof UserPrompt], value, key);
    assert.deepEqual(labels(p), choices);
    assert.equal(p.text, text);
  });
}

// S8, the seam: the text each kind's prompt shows is the text promptOf recognizes it by, both from src/prompts.ts; no
// two kinds share a text, and the catalog above covers every kind.
test("every kind's hint is recognized as that kind, and no two kinds share a hint", () => {
  for (const [kind, hint] of Object.entries(HINTS)) {
    assert.equal(promptOf(hint).kind, kind);
    assert.equal(promptOf(prompts.withOffer(hint)).kind, kind);
  }
  assert.equal(new Set(Object.values(HINTS)).size, Object.keys(HINTS).length);
  assert.deepEqual(catalog.map(([, e]) => e.kind).sort(), Object.keys(HINTS).sort());
});

test("an unknown text is free text plus Quit", () => {
  assert.deepEqual(labels(promptOf("Something new > ")), ["Quit=q"]);
  assert.equal(promptOf("Something new > ").free, "line");
});

test("promptOf never throws and always offers exactly one Quit that its input mode reads as quitting", () => {
  const texts = fc.oneof(
    fc.string(),
    fc.constantFrom(...catalog.map(([t]) => t)),
    fc.constantFrom(...catalog.map(([t]) => prompts.withOffer(t))),
  );
  fc.assert(
    fc.property(texts, (text) => {
      const p = promptOf(text);
      const quit = p.choices.filter((c) => c.label === "Quit");
      return quit.length === 1 && quits(p, quit[0].sends) && p.choices.filter((c) => c.label !== "Quit").every((c) => !quits(p, c.sends));
    }),
  );
});

test("numberedChoices turns the numbered answers of the prescribed format into choices sending the number", () => {
  assert.deepEqual(numberedChoices(NUMBERED_MESSAGE), [
    { label: "1. PostgreSQL - the default, already in the container", sends: "1" },
    { label: "2. SQLite - no server needed", sends: "2" },
    { label: "3. Both, chosen by configuration", sends: "3" },
  ]);
});

test("numberedChoices tolerates n) and n: and ignores numbers inside prose", () => {
  assert.deepEqual(numberedChoices("Pick one:\n1) Yes\n2: No"), [
    { label: "1) Yes", sends: "1" },
    { label: "2: No", sends: "2" },
  ]);
  assert.deepEqual(numberedChoices("We have 2. options here, and 3 more."), []);
  assert.deepEqual(numberedChoices("No numbers at all."), []);
});

test("every choice of numberedChoices sends the decimal number of its line", () => {
  fc.assert(
    fc.property(fc.array(fc.tuple(fc.integer({ min: 1, max: 99 }), fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,20}$/)), { maxLength: 6 }), (lines) => {
      const message = lines.map(([n, t]) => `${n}. ${t}`).join("\n");
      const choices = numberedChoices(message);
      return choices.length === lines.length && choices.every((c, i) => c.sends === String(lines[i][0]) && c.label.startsWith(`${lines[i][0]}. `));
    }),
  );
});

// Decision support, plan step 3.2: the offer is a property of the prompt text (D1).
test("a prompt with the offer line has the entry of its text plus Help me decide before Quit; without the line nothing changes", () => {
  for (const [text, expected, choices] of catalog) {
    const offered = promptOf(prompts.withOffer(text));
    assert.equal(offered.kind, expected.kind);
    assert.equal(offered.text, prompts.withOffer(text));
    assert.deepEqual(labels(offered), [...choices.slice(0, -1), `${prompts.HELP_ME_DECIDE}=/decide`, choices[choices.length - 1]]);
    assert.ok(!labels(promptOf(text)).some((l) => l.startsWith(prompts.HELP_ME_DECIDE)), `${expected.kind} carries the offer without the line`);
  }
  assert.equal(prompts.pagePromptText("decision", prompts.withOffer(prompts.decisionPrompt)), "Choose an option, answer in your own words, or continue without deciding.");
  assert.equal(prompts.pagePromptText("unknown", prompts.withOffer("Something > ")), "Something");
});

// W2-R1-2: an interview option is its label without the number, its description apart.
test("numberedOptionLabels gives each numbered answer's label without the number, and its description", () => {
  assert.deepEqual(numberedOptionLabels(NUMBERED_MESSAGE), [
    { label: "PostgreSQL", description: "the default, already in the container" },
    { label: "SQLite", description: "no server needed" },
    { label: "Both, chosen by configuration", description: "" },
  ]);
  assert.deepEqual(numberedOptionLabels("Pick:\n1) SQLite — a file\n2: PostgreSQL"), [{ label: "SQLite", description: "a file" }, { label: "PostgreSQL", description: "" }]);
  assert.deepEqual(numberedOptionLabels("No list here."), []);
});
