import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigInvalid, haltMessage, ProjectChanged } from "../src/errors.ts";

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
