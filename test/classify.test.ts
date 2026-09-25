import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, counted } from "../prototypes/classify.ts";

// Finding 32: the prototype's "accepted" count once came from a string test that also matched "accepted, DOES NOT DECODE".
test("a call whose reply does not decode is not counted as accepted", () => {
  assert.equal(classify("accepted", true), "accepted");
  assert.equal(classify("accepted", false), "accepted_undecodable");
  assert.equal(classify("rejected", false), "rejected");
  assert.equal(classify("timeout", false), "timeout");
  assert.deepEqual([counted("accepted"), counted("accepted_undecodable"), counted("rejected"), counted("timeout")], [true, false, false, false]);
});
