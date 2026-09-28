import assert from "node:assert/strict";
import { test } from "node:test";
import { lineChange } from "../src/lineChange.ts";

// Issue #31: what the program measures of the reviewed file during a response: whether it changed at all, and the
// numbers of lines added and removed.

test("identical text: unchanged, nothing added or removed", () => {
  assert.deepEqual(lineChange("a\nb\nc\n", "a\nb\nc\n"), { changed: false, added: 0, removed: 0 });
});

test("one line edited: one removed, one added", () => {
  assert.deepEqual(lineChange("a\nb\nc\n", "a\nB\nc\n"), { changed: true, added: 1, removed: 1 });
});

test("lines appended and lines deleted", () => {
  assert.deepEqual(lineChange("a\nb\n", "a\nb\nc\nd\n"), { changed: true, added: 2, removed: 0 });
  assert.deepEqual(lineChange("a\nb\nc\nd\n", "a\nd\n"), { changed: true, added: 0, removed: 2 });
});

test("whitespace changed on a line: changed, and counted as an edited line", () => {
  assert.deepEqual(lineChange("a\nb\n", "a\nb \n"), { changed: true, added: 1, removed: 1 });
});

test("a trailing newline added only: changed, no line counted", () => {
  assert.deepEqual(lineChange("a\nb", "a\nb\n"), { changed: true, added: 0, removed: 0 });
});

test("the empty file to content and back", () => {
  assert.deepEqual(lineChange("", "a\nb\n"), { changed: true, added: 2, removed: 0 });
  assert.deepEqual(lineChange("a\nb\n", ""), { changed: true, added: 0, removed: 2 });
  assert.deepEqual(lineChange("", ""), { changed: false, added: 0, removed: 0 });
});

test("a 5,000-line file with one change completes and counts 1 and 1", () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
  const before = lines.join("\n") + "\n";
  const after = lines.map((l, i) => (i === 2500 ? "changed" : l)).join("\n") + "\n";
  assert.deepEqual(lineChange(before, after), { changed: true, added: 1, removed: 1 });
});

test("two very different large files complete (no recursion, bounded work)", () => {
  const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n");
  const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n");
  assert.deepEqual(lineChange(a, b), { changed: true, added: 3000, removed: 3000 });
});

// The #30 run: plan.json holds a step's text as one JSON string, so amendments within one step are one changed line.
test("plan.json: three paragraphs added to one step's text are one line removed and one added", () => {
  const plan = (text: string) => JSON.stringify({ version: 2, plan: { stages: [{ number: 1, title: "t", steps: [{ id: "S1", text }] }] } }, null, 2) + "\n";
  const before = plan("Step 10.1.");
  assert.deepEqual(lineChange(before, plan("Step 10.1.\n\nOne.\n\nTwo.\n\nThree.")), { changed: true, added: 1, removed: 1 });
  assert.deepEqual(lineChange(before, before), { changed: false, added: 0, removed: 0 });
});
