import assert from "node:assert/strict";
import { test } from "node:test";
import { answerOf, emptyFold, foldLine, isDecide, type LineFold, parseInterviewMessage } from "../src/input.ts";

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

// Decision support, plan step 3.1: the command of the offer.
test("isDecide recognizes /decide with surrounding white space only", () => {
  assert.equal(isDecide("/decide"), true);
  assert.equal(isDecide("  /decide \n"), true);
  assert.equal(isDecide("/decide now"), false);
  assert.equal(isDecide("decide"), false);
  assert.equal(isDecide("/Decide"), false);
});

test("answerOf: a number chooses an option and yields its label and description; anything else is the reply", () => {
  const options = [{ label: "Keep", description: "the planner's position" }, { label: "Change", description: "" }];
  assert.equal(answerOf("1", options), "Keep: the planner's position");
  assert.equal(answerOf(" 2 ", options), "Change");
  assert.equal(answerOf("3", options), "3");
  assert.equal(answerOf("keep it as it is", options), "keep it as it is");
  assert.equal(answerOf("", options), "");
});
