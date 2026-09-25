import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import fc from "fast-check";
import { type Json, strictJsonSchema } from "../src/jsonSchema.ts";

// Row 8 of the table in recommendation E of docs/functional-design-review.md: the strict JSON Schema transform.
const RUNS = { numRuns: 200, seed: 20260925 };
const key = fc.stringMatching(/^[a-z]{1,3}$/);
const defName = fc.constantFrom("A", "B", "C");
const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") for (const v of Object.values(value as object)) deepFreeze(v);
  return Object.freeze(value);
};
/** A schema node of bounded depth; a `$ref` names one of the definitions. */
const node = (depth: number): fc.Arbitrary<Json> =>
  depth === 0
    ? fc.oneof(fc.constant({ type: "string" }), fc.constant({ type: "number" }), defName.map((n) => ({ $ref: `#/$defs/${n}` })))
    : fc.oneof(
        { weight: 2, arbitrary: node(0) },
        { weight: 2, arbitrary: fc.dictionary(key, node(depth - 1), { maxKeys: 3 }).map((properties) => ({ type: "object", properties }) as Json) },
        { weight: 1, arbitrary: node(depth - 1).map((items) => ({ type: "array", items }) as Json) },
        { weight: 1, arbitrary: fc.array(node(depth - 1), { minLength: 1, maxLength: 2 }).map((anyOf) => ({ anyOf }) as Json) },
      );
/** Definitions A, B, C where A may refer to B, B to C, and C to nothing: acyclic by construction. */
const acyclicDefs: fc.Arbitrary<Json> = fc
  .tuple(node(1), node(1), node(1))
  .map(([a, b, c]) => ({ A: restrict(a, ["B", "C"]), B: restrict(b, ["C"]), C: restrict(c, []) }));
/** Replaces every `$ref` outside the allowed names by a string node. */
function restrict(json: Json, allowed: readonly string[]): Json {
  const walk = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(walk);
    if (n === null || typeof n !== "object") return n;
    const o = n as Json;
    if (typeof o.$ref === "string") return allowed.some((name) => o.$ref === `#/$defs/${name}`) ? o : { type: "string" };
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, walk(v)]));
  };
  return walk(json) as Json;
}
const arbAcyclic: fc.Arbitrary<Json> = fc.tuple(node(2), acyclicDefs).map(([root, $defs]) => ({ ...root, $defs }));

const everyObjectClosed = (n: unknown): boolean => {
  if (Array.isArray(n)) return n.every(everyObjectClosed);
  if (n === null || typeof n !== "object") return true;
  const o = n as Json;
  if (o.type === "object" && o.properties !== undefined) {
    const keys = Object.keys(o.properties as Json);
    if (o.additionalProperties !== false || JSON.stringify(o.required) !== JSON.stringify(keys)) return false;
  }
  return Object.values(o).every(everyObjectClosed);
};
const hasRef = (n: unknown): boolean => (Array.isArray(n) ? n.some(hasRef) : n !== null && typeof n === "object" ? ("$ref" in (n as Json) || Object.values(n as Json).some(hasRef)) : false);

test("property: on acyclic schema graphs the strict transform is deterministic, input-preserving, idempotent, and closes every object", () => {
  fc.assert(
    fc.property(arbAcyclic, (input) => {
      const frozen = deepFreeze(structuredClone(input));
      const before = JSON.stringify(frozen);
      const once = strictJsonSchema(frozen);
      assert.ok(Result.isSuccess(once), JSON.stringify(input));
      assert.equal(JSON.stringify(frozen), before, "the input changed");
      const twice = strictJsonSchema(frozen);
      assert.ok(Result.isSuccess(twice));
      assert.deepEqual(twice.success, once.success, "not deterministic");
      const again = strictJsonSchema(once.success);
      assert.ok(Result.isSuccess(again));
      assert.deepEqual(again.success, once.success, "not idempotent");
      assert.ok(everyObjectClosed(once.success), "an object is not closed");
      assert.ok(!hasRef(once.success), "a $ref survived");
    }),
    RUNS,
  );
});

test("property: a dangling or a cyclic reference is a typed rejection", () => {
  fc.assert(
    fc.property(arbAcyclic, fc.nat(), (input, pick) => {
      const dangling = { type: "object", properties: { zz: { $ref: "#/$defs/Missing" }, rest: { type: "array", items: { ...input, $defs: undefined } } }, $defs: input.$defs };
      const rejected = strictJsonSchema(dangling);
      assert.ok(Result.isFailure(rejected) && rejected.failure.reason === "dangling_ref", "a dangling reference was accepted");
      const names = ["A", "B", "C"];
      const name = names[pick % names.length];
      const cyclic = { type: "object", properties: { a: { $ref: `#/$defs/${name}` } }, $defs: { ...(input.$defs as Json), [name]: { type: "object", properties: { self: { $ref: `#/$defs/${name}` } } } } };
      const loop = strictJsonSchema(cyclic);
      assert.ok(Result.isFailure(loop) && loop.failure.reason === "cyclic_ref", "a cycle was not rejected");
    }),
    RUNS,
  );
});
