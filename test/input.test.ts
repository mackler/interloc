import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyFold, foldLine, type LineFold, parseInterviewMessage } from "../src/input.ts";

// Plan step 3.4 (finding 25): the interview's commands and the line protocol as pure functions.

test("parseInterviewMessage: empty, /done, or text (trimmed)", () => {
  assert.deepEqual(parseInterviewMessage(""), { kind: "empty" });
  assert.deepEqual(parseInterviewMessage("   "), { kind: "empty" });
  assert.deepEqual(parseInterviewMessage("/done"), { kind: "done" });
  assert.deepEqual(parseInterviewMessage(" /done "), { kind: "done" });
  assert.deepEqual(parseInterviewMessage("  use the logger  "), { kind: "text", text: "use the logger" });
  assert.deepEqual(parseInterviewMessage("/quit"), { kind: "text", text: "/quit" }); // quitting is the Ui's command
});

const fold = (...lines: string[]): LineFold => lines.reduce(foldLine, emptyFold);

test("foldLine: a single line completes the message; a triple-quoted block collects lines until it closes", () => {
  assert.deepEqual(fold("one line"), { block: false, lines: ["one line"], complete: true });
  assert.deepEqual(fold('"""'), { block: true, lines: [], complete: false });
  assert.deepEqual(fold('"""', "a", "", "b"), { block: true, lines: ["a", "", "b"], complete: false });
  assert.deepEqual(fold('"""', "a", "", "b", '"""'), { block: true, lines: ["a", "", "b"], complete: true });
  assert.deepEqual(fold('"""', '"""'), { block: true, lines: [], complete: true });
  assert.deepEqual(fold(' """ ', "x", '"""  '), { block: true, lines: ["x"], complete: true });
});
