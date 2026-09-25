import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { decodeQuestions, decodeToolTarget, interpretExecution, reduceMessages } from "../src/claudeEvents.ts";
import { assistantText, failure, init, success } from "./fakeSdk.ts";

// Finding 17: the AskUserQuestion input is decoded, not asserted.
test("decodeQuestions accepts the SDK's question list and ignores the fields the program does not read", () => {
  const input = { questions: [{ question: "A or B?", header: "Choice", multiSelect: false, options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] };
  const result = decodeQuestions(input);
  assert.ok(Result.isSuccess(result));
  assert.deepEqual(result.success, [{ question: "A or B?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }]);
});

test("decodeQuestions treats a missing question list as empty", () => {
  const result = decodeQuestions({});
  assert.ok(Result.isSuccess(result));
  assert.deepEqual(result.success, []);
});

test("decodeQuestions fails with a message that names the field when the list is not an array or a question has no options", () => {
  const notArray = decodeQuestions({ questions: "nope" });
  assert.ok(Result.isFailure(notArray));
  assert.match(notArray.failure, /questions/);
  const noOptions = decodeQuestions({ questions: [{ question: "A?" }] });
  assert.ok(Result.isFailure(noOptions));
  assert.match(noOptions.failure, /questions\[0\]\.options/);
  const notObject = decodeQuestions("nope");
  assert.ok(Result.isFailure(notObject));
});

test("decodeToolTarget reads file_path, then notebook_path, and yields null for anything else", () => {
  assert.equal(decodeToolTarget({ file_path: "a/b.ts" }), "a/b.ts");
  assert.equal(decodeToolTarget({ notebook_path: "n.ipynb" }), "n.ipynb");
  assert.equal(decodeToolTarget({ file_path: "a", notebook_path: "n" }), "a");
  assert.equal(decodeToolTarget({ file_path: 42 }), null);
  assert.equal(decodeToolTarget({}), null);
  assert.equal(decodeToolTarget(null), null);
  assert.equal(decodeToolTarget("a"), null);
});

// Finding 19: the reduction of the message list is pure, and partial output is explicit.
test("reduceMessages folds init and a success result into a complete outcome", () => {
  assert.deepEqual(reduceMessages([init("s-9"), assistantText("working"), success({ a: 1 }, "done", 0.5)]), {
    sessionId: "s-9", costUsd: 0.5, structured: { a: 1 }, resultText: "done", error: null, partial: false,
  });
});

test("reduceMessages reports a failed result as an error of a complete call, not as partial output", () => {
  assert.deepEqual(reduceMessages([init(), failure("error_max_turns", 0.1)]), {
    sessionId: "session-1", costUsd: 0.1, structured: null, resultText: "", error: "error_max_turns", partial: false,
  });
});

test("reduceMessages marks a stream that ended before a result as partial, with the stream failure or the missing-result text", () => {
  assert.deepEqual(reduceMessages([init(), assistantText("half")]), {
    sessionId: "session-1", costUsd: null, structured: null, resultText: "", error: "the call produced no result message", partial: true,
  });
  assert.deepEqual(reduceMessages([init()], "socket hang up"), {
    sessionId: "session-1", costUsd: null, structured: null, resultText: "", error: "socket hang up", partial: true,
  });
  assert.deepEqual(reduceMessages([]), {
    sessionId: null, costUsd: null, structured: null, resultText: "", error: "the call produced no result message", partial: true,
  });
});

const complete = (structured: unknown, resultText = "") => ({ sessionId: "s", costUsd: 1, structured, resultText, error: null, partial: false });

test("interpretExecution returns the report when it is valid and there is no stop", () => {
  const outcome = interpretExecution(complete({ status: "finished", summary: "all done", question: "", remaining_work: "" }), null);
  assert.deepEqual(outcome, { status: "finished", summary: "all done", question: "", remainingWork: "", userInput: null });
});

test("interpretExecution gives a recorded stop precedence over the report, valid or not", () => {
  const stop = { question: "A or B?", input: "A or B? -> A" };
  const valid = interpretExecution(complete({ status: "finished", summary: "s", question: "", remaining_work: "w" }), stop);
  assert.deepEqual(valid, { status: "needs_input", summary: "s", question: "A or B?", remainingWork: "w", userInput: "A or B? -> A" });
  const invalid = interpretExecution(complete({ status: "bogus" }), stop);
  assert.deepEqual(invalid, { status: "needs_input", summary: "", question: "A or B?", remainingWork: "", userInput: "A or B? -> A" });
});

test("interpretExecution treats a missing or invalid report and a call error as aborted, keeping the result text", () => {
  const invalid = interpretExecution(complete({ status: "bogus" }, "text only"), null);
  assert.equal(invalid.status, "aborted");
  assert.equal(invalid.summary, "text only");
  assert.match(invalid.question, /ended without a status report: the status report does not match its schema/);
  const missing = interpretExecution(complete(null, "text only"), null);
  assert.match(missing.question, /ended without a status report: no structured output/);
  const failed = interpretExecution({ ...complete(null), error: "error_during_execution" }, null);
  assert.equal(failed.status, "aborted");
  assert.match(failed.question, /ended without a status report: error_during_execution/);
});
