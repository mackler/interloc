import assert from "node:assert/strict";
import { test } from "node:test";
import { haltMessage, ProjectChanged } from "../src/errors.ts";

test("haltMessage reports a typed error with its description", () => {
  const error = new ProjectChanged({ during: "planning", fileLabel: null, changes: ["new status line:  M a.txt"] });
  const message = haltMessage(error);
  assert.match(message ?? "", /^HALTED: the project outside plan-review\/ changed during a planning-phase call/);
  assert.match(message ?? "", /a\.txt/);
});

test("haltMessage returns null for an unrelated error", () => {
  assert.equal(haltMessage(new TypeError("x is not a function")), null);
});
