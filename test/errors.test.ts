import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigInvalid, decodeRunError, GitError, haltMessage, ProjectChanged } from "../src/errors.ts";

test("haltMessage reports a typed error with its description", () => {
  const error = new ProjectChanged({ during: "planning", fileLabel: null, changes: [{ kind: "content_changed", path: "a.txt" }] });
  const message = haltMessage(error);
  assert.match(message ?? "", /^HALTED: the project outside plan-review\/ changed during a planning-phase call/);
  assert.match(message ?? "", /a\.txt/);
});

test("haltMessage returns null for an unrelated error", () => {
  assert.equal(haltMessage(new TypeError("x is not a function")), null);
});

test("haltMessage reports ConfigInvalid with the file and field path", () => {
  const error = new ConfigInvalid({ file: "/p/plan-review/config.json", path: "maxRounds", message: "Expected number" });
  assert.equal(haltMessage(error), "HALTED: /p/plan-review/config.json is not a valid configuration: Expected number (at maxRounds)");
});

// Finding 10: a value that only carries one of our tags is not one of our errors; the payload is validated.
test("haltMessage returns null for a tagged value without the payload of its tag", () => {
  assert.equal(haltMessage({ _tag: "GitError" }), null);
  assert.equal(haltMessage({ _tag: "ProjectChanged", during: "planning", fileLabel: null, changes: "none" }), null);
  assert.equal(haltMessage({ _tag: "NotOurs", message: "m" }), null);
});

test("decodeRunError accepts an instance and a plain payload alike, and haltMessage renders both", () => {
  const instance = new GitError({ args: ["status"], message: "not a repository" });
  assert.equal(haltMessage(instance), "HALTED: git status failed: not a repository");
  const plain = { _tag: "GitError", args: ["status"], message: "not a repository" };
  assert.equal(decodeRunError(plain)?._tag, "GitError");
  assert.equal(haltMessage(plain), "HALTED: git status failed: not a repository");
  assert.equal(decodeRunError(null), null);
});
