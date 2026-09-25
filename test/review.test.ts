import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect, Layer } from "effect";
import { decodeWithRepair } from "../src/review.ts";
import * as S from "../src/schema.ts";
import { Store, type StoreShape } from "../src/services.ts";
import { makeStore, platformLayer } from "../src/store.ts";
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
    const repair = (prompt: string) => Effect.sync(() => (prompts.push(prompt), { questions_for_user: [] }));
    const output = await Effect.runPromise(decodeWithRepair("claude", S.PlanWriteResult, reply, repair).pipe(Effect.provide(Layer.succeed(Store, s))));
    assert.deepEqual(output, { questions_for_user: [] });
    assert.equal(prompts.length, 1, "the repair turn did not run");
    assert.match(fs.readFileSync(path.join(s.dir, "invalid-replies", "claude-1.json"), "utf8"), /reply not serializable/);
  });
}
