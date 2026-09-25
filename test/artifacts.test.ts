import assert from "node:assert/strict";
import { test } from "node:test";
import { type Artifact, pathOf, phaseOf, recordPath, reviewedFile, subjectDir, subjectOf } from "../src/artifacts.ts";

// Finding 28: one catalog of the records; every path the program writes or names comes from `pathOf`.
test("pathOf gives every record its path under plan-review/", () => {
  const cases: [Artifact, string][] = [
    [{ kind: "conversation" }, "conversation.md"],
    [{ kind: "decisions" }, "user-decisions.md"],
    [{ kind: "feedback" }, "reviewer-feedback.md"],
    [{ kind: "usage" }, "usage.jsonl"],
    [{ kind: "questions" }, "questions.json"],
    [{ kind: "requirements" }, "requirements.md"],
    [{ kind: "plan" }, "plan.md"],
    [{ kind: "checkpoint" }, "checkpoint.json"],
    [{ kind: "config" }, "config.json"],
    [{ kind: "log", subject: "questions" }, "questions-log.json"],
    [{ kind: "log", subject: "requirements" }, "requirements-log.json"],
    [{ kind: "log", subject: { plan: 3 } }, "issue-log.json"],
    [{ kind: "review", subject: "questions", round: 1 }, "question-review/review-1.json"],
    [{ kind: "response", subject: "requirements", round: 2 }, "requirements-review/cc-2.json"],
    [{ kind: "round", subject: { plan: 4 }, round: 3 }, "planning-4/round-3.json"],
    [{ kind: "planWrite", phase: 2 }, "planning-2/cc-0.json"],
    [{ kind: "execution", phase: 2 }, "execution-2/result.json"],
    [{ kind: "invalidReply", agent: "codex", n: 2 }, "invalid-replies/codex-2.json"],
  ];
  for (const [artifact, expected] of cases) assert.equal(pathOf(artifact), expected, JSON.stringify(artifact));
  assert.equal(recordPath({ kind: "plan" }), "plan-review/plan.md");
});

test("subjects: directory names, phases, reviewed files, and the inverse of the directory name", () => {
  assert.equal(subjectDir("questions"), "question-review");
  assert.equal(subjectDir("requirements"), "requirements-review");
  assert.equal(subjectDir({ plan: 7 }), "planning-7");
  assert.deepEqual([phaseOf("questions"), phaseOf("requirements"), phaseOf({ plan: 7 })], [0, 0, 7]);
  assert.deepEqual([reviewedFile("questions"), reviewedFile("requirements"), reviewedFile({ plan: 1 })], [{ kind: "questions" }, { kind: "requirements" }, { kind: "plan" }]);
  assert.deepEqual([subjectOf("question-review"), subjectOf("requirements-review"), subjectOf("planning-12"), subjectOf("planning-0"), subjectOf("execution-1"), subjectOf("planning-x")], ["questions", "requirements", { plan: 12 }, null, null, null]);
});
