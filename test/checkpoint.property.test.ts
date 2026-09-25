import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import fc from "fast-check";
import { appendUserDecision } from "../src/issueLog.ts";
import { platformLayer } from "../src/platform.ts";
import { readCheckpoint } from "../src/records.ts";
import { renderDecision } from "../src/render.ts";
import type { DecisionEvent } from "../src/reviewState.ts";
import { run } from "../src/run.ts";
import type { IssueId } from "../src/schema.ts";
import { faultyPlatform, finished, issue, respond, tempRepo, testLayer } from "./helpers.ts";

// Row 9 of the table in recommendation E of docs/functional-design-review.md: decisions and checkpoints.
const RUNS = { numRuns: 200, seed: 20260925 };
const record = <T>(shape: { [K in keyof T]: fc.Arbitrary<T[K]> }): fc.Arbitrary<T> => fc.record(shape, { noNullPrototype: true }) as fc.Arbitrary<T>;
const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") for (const v of Object.values(value as object)) deepFreeze(v);
  return Object.freeze(value);
};
const arbEvent: fc.Arbitrary<DecisionEvent> = record({
  subject: fc.string({ minLength: 1 }),
  id: fc.option(fc.stringMatching(/^[A-Z][A-Z0-9-]{0,7}$/).map((s) => s as IssueId), { nil: null }),
  decision: fc.string({ minLength: 1 }),
  phase: fc.nat({ max: 9 }),
  round: fc.nat({ max: 9 }),
});

test("property: the issue-log entry and the transcript lines of a decision carry the same subject, id and decision, and rendering does not change the event", () => {
  fc.assert(
    fc.property(arbEvent, (event) => {
      const frozen = deepFreeze(structuredClone(event));
      const lines = renderDecision(frozen);
      assert.ok(lines.record.startsWith(`Subject: ${event.subject}\nDecision: ${event.decision}\n`));
      assert.ok(lines.conversation.includes(event.subject) && lines.conversation.includes(event.decision));
      if (event.id !== null) {
        const entry = appendUserDecision([], event.id, event.decision, event.phase, event.round).at(-1);
        assert.deepEqual([entry?.id, entry?.rationale, entry?.phase, entry?.round, entry?.source, entry?.action], [event.id, event.decision, event.phase, event.round, "user", "decided_by_user"]);
      }
      assert.deepEqual(frozen, event);
    }),
    RUNS,
  );
});

test("property: with a write failure injected at any one persistence step, the checkpoint never names a transition whose records are incomplete", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 60 }), async (failAt) => {
      const { layer, probe } = testLayer(tempRepo(), {
        steps: [{ output: { questions_for_user: [] }, plan: "v1" }, { output: respond([["A", "accepted"]]), plan: "v2" }],
        reviews: [{ issues: [issue("A")] }, { issues: [] }],
        execs: [finished],
        platform: faultyPlatform((_, count) => count === failAt),
      });
      await Effect.runPromiseExit(run("task").pipe(Effect.provide(layer)));
      // The reader verifies the named records; a checkpoint that names incomplete records is a failure here.
      await Effect.runPromise(readCheckpoint(probe.dir).pipe(Effect.provide(platformLayer)));
    }),
    { numRuns: 30, seed: 20260925 },
  );
});
