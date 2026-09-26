import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { parseAskLine, parseMessage } from "../src/input.ts";
import * as prompts from "../src/prompts.ts";
import { numberedChoices, promptOf, type UserPrompt } from "../src/userPrompts.ts";
import { NUMBERED_MESSAGE } from "./interviewFixture.ts";

const quits = (p: UserPrompt, sends: string): boolean => (p.mode === "ask" ? parseAskLine(sends).kind === "quit" : parseMessage(sends).kind === "quit");
const labels = (p: UserPrompt): string[] => p.choices.map((c) => `${c.label}=${c.sends}`);

// Every text of the catalog, with the entry it must map to.
const catalog: [string, Partial<UserPrompt> & { kind: UserPrompt["kind"] }, string[]][] = [
  [prompts.decisionPrompt("issue P1-R1-1, raised again"), { kind: "decision", mode: "ask", free: "line" }, ["No decision=", "Quit=q"]],
  [prompts.limitPrompt(10, "proceed to execution"), { kind: "limit", mode: "ask", free: "line" }, ["Proceed=p", "Stop=0", "Quit=q"]],
  [prompts.limitNoProceedPrompt(10), { kind: "limitNoProceed", mode: "ask", free: "line" }, ["Stop=0", "Quit=q"]],
  [prompts.execInputPrompt, { kind: "execInput", mode: "ask", free: "line" }, ["Quit=q"]],
  [prompts.optionOrTextPrompt, { kind: "optionOrText", mode: "ask", free: "line", extra: "questionOptions" }, ["Quit=q"]],
  [prompts.permissionPrompt, { kind: "permission", mode: "ask", free: "none" }, ["Allow=y", "Deny=n", "Quit=q"]],
  [prompts.interviewMessagePrompt, { kind: "interviewMessage", mode: "message", free: "message", extra: "numberedAnswers" }, ["End interview=/done", "Quit=/quit"]],
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

test("the proceed label of a limit prompt does not confuse it with the prompt without proceed", () => {
  assert.equal(promptOf(prompts.limitPrompt(3, "start execution anyway")).kind, "limit");
  assert.equal(promptOf(prompts.limitNoProceedPrompt(3)).kind, "limitNoProceed");
});

test("an unknown text is free text plus Quit", () => {
  assert.deepEqual(labels(promptOf("Something new > ")), ["Quit=q"]);
  assert.equal(promptOf("Something new > ").free, "line");
});

test("promptOf never throws and always offers exactly one Quit that its input mode reads as quitting", () => {
  const texts = fc.oneof(
    fc.string(),
    fc.string().map(prompts.decisionPrompt),
    fc.tuple(fc.nat(), fc.string()).map(([n, l]) => prompts.limitPrompt(n, l)),
    fc.nat().map(prompts.limitNoProceedPrompt),
    fc.constantFrom(...catalog.map(([t]) => t)),
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
