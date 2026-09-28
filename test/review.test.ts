import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Layer, Result } from "effect";
import { UserStopped } from "../src/errors.ts";
import { decodeValidating, decodeWithRepair, planningCall, type Repair } from "../src/review.ts";
import { Planner } from "../src/services.ts";
import { noDecider, pathsOf, ScriptedPlanner } from "./helpers.ts";
import * as S from "../src/schema.ts";
import { Decider, Store, type StoreShape } from "../src/services.ts";
import { platformLayer } from "../src/platform.ts";
import { makeStore } from "../src/store.ts";
import { tempRepo } from "./helpers.ts";

const store = async (): Promise<StoreShape> => {
  const s = await Effect.runPromise(makeStore(tempRepo(), []).pipe(Effect.provide(platformLayer)));
  await Effect.runPromise(s.init("task"));
  return s;
};

// Finding 22 of docs/functional-design-review.md: keeping an invalid reply serialized it with JSON.stringify
// outside any error channel, so a reply with a BigInt or a cycle was a defect instead of a repair turn.
for (const [what, reply] of [["a BigInt", { questions_for_user: 1n }], ["a cycle", (() => { const c: Record<string, unknown> = { questions_for_user: "x" }; c.self = c; return c; })()]] as const) {
  test(`an invalid reply containing ${what} is kept with the serialization failure named, and the repair turn runs`, async () => {
    const s = await store();
    const prompts: string[] = [];
    const repair = (r: Repair) => Effect.sync(() => (prompts.push(r.prompt), { questions_for_user: [] }));
    const output = await Effect.runPromise(decodeWithRepair("claude", S.PlanWriteResult, reply, repair).pipe(Effect.provide(Layer.succeed(Store, s))));
    assert.deepEqual(output, { questions_for_user: [] });
    assert.equal(prompts.length, 1, "the repair turn did not run");
    assert.match(fs.readFileSync(path.join(s.dir, "invalid-replies", "claude-1.json"), "utf8"), /reply not serializable/);
  });
}

// Plan step 3.4 (finding 25): the repair is reported in the result instead of being tracked in a mutable binding.
test("planningCall reports whether a repair turn was needed", async () => {
  const repo = tempRepo();
  const s = await Effect.runPromise(makeStore(repo, []).pipe(Effect.provide(platformLayer)));
  await Effect.runPromise(s.init("task"));
  const planner = new ScriptedPlanner(pathsOf(repo), [{ output: { questions_for_user: "x" } }, { output: { questions_for_user: [] } }, { output: { questions_for_user: [{ question: "q", options: [] }] } }], []);
  const layer = Layer.mergeAll(Layer.succeed(Store, s), Layer.succeed(Planner, planner), Layer.succeed(Decider, noDecider));
  const repaired = await Effect.runPromise(planningCall("first", S.PlanWriteResult).pipe(Effect.provide(layer)));
  assert.equal(repaired.repaired, true);
  assert.deepEqual(repaired.output, { questions_for_user: [] });
  const direct = await Effect.runPromise(planningCall("second", S.PlanWriteResult).pipe(Effect.provide(layer)));
  assert.equal(direct.repaired, false);
  assert.deepEqual(direct.output, { questions_for_user: [{ question: "q", options: [] }] });
});

// Plan step S10 (issue #30): one kind of second turn for a defective reply, the Repair, whose kind names its budget.
test("decodeValidating hands its repair a Repair of kind schema, then of kind validation, each budget once", async () => {
  const s = await store();
  const kinds: string[] = [];
  const replies: unknown[] = [{ questions_for_user: [{ question: "q", options: [] }] }, { questions_for_user: [] }];
  const repair = (r: Repair) => Effect.sync(() => (kinds.push(r.kind), replies.shift()));
  const validate = (v: { questions_for_user: readonly unknown[] }) =>
    v.questions_for_user.length === 0 ? Result.succeed({ value: v, notes: [] }) : Result.fail({ error: new UserStopped({ where: "x" }), repair: "no questions, please" });
  const out = await Effect.runPromise(decodeValidating("claude", S.PlanWriteResult, { questions_for_user: "x" }, repair, validate as never).pipe(Effect.provide(Layer.succeed(Store, s))));
  assert.deepEqual(out.value, { questions_for_user: [] });
  assert.deepEqual(kinds, ["schema", "validation"]);
});
