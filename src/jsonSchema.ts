// The JSON Schema that the agents receive, derived from the Effect schemas of src/schema.ts, so
// that type, JSON Schema and validation have one source. API names: docs/effect-v4-api.md.
//
// Both agents accept the generated schema as it is: the proof of plan step 0.4 (run.txt in
// prototypes/proto-schema-output/) shows 28 accepted calls, and `onExcessProperty: "error"` already
// yields `additionalProperties: false` with a complete `required` list. `strictJsonSchema` is the
// fallback for a future Effect version that generates something looser, and `agentJsonSchema`
// selects the variant that the proof recorded.

import { Result, Schema } from "effect";

export type Json = Record<string, unknown>;

/** The generated JSON Schema. `definitions` becomes `$defs`, so that a `$ref` can be resolved. */
export const rawJsonSchema = (schema: Schema.Top): Json => {
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" });
  const definitions = document.definitions as Json;
  const json = document.schema as Json;
  return Object.keys(definitions).length > 0 ? { ...json, $defs: definitions } : json;
};

/** Why the strict transform rejects a schema (finding 24), and the path of the node (`properties.a.items`). */
export type UnsupportedSchema = Readonly<{ reason: "dangling_ref" | "cyclic_ref" | "ref_with_siblings" | "depth"; at: string }>;
const MAX_DEPTH = 64;
const COMBINATORS = ["anyOf", "oneOf", "allOf"] as const;
const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Every object gets `additionalProperties: false` and `required` = all of its property keys, and
 * every `$ref` is replaced by the definition it names. Codex's strict structured output requires
 * both; an optional key cannot survive this transform, and none of the agent schemas has one.
 * Only `properties`, `items`, `$defs` and `anyOf` / `oneOf` / `allOf` are walked as schema nodes;
 * every other value is copied as it is. Total: a reference that names no definition, a cycle of
 * references, a `$ref` with sibling keys, or a nesting deeper than the bound is a typed rejection.
 */
export const strictJsonSchema = (json: Json): Result.Result<Json, UnsupportedSchema> => {
  const definitions = isObject(json.$defs) ? json.$defs : {};
  const reject = (reason: UnsupportedSchema["reason"], at: readonly string[]): Result.Result<never, UnsupportedSchema> => Result.fail({ reason, at: at.join(".") });
  const walk = (node: unknown, at: readonly string[], stack: readonly string[]): Result.Result<unknown, UnsupportedSchema> => {
    if (at.length > MAX_DEPTH) return reject("depth", at);
    if (!isObject(node)) return Result.succeed(node);
    if (typeof node.$ref === "string") {
      // `$defs` beside a root `$ref` is the container of the definitions, not a constraint of the node.
      if (Object.keys(node).some((key) => key !== "$ref" && key !== "$defs")) return reject("ref_with_siblings", at);
      const name = node.$ref.startsWith("#/$defs/") ? node.$ref.slice("#/$defs/".length) : null;
      if (name === null || !Object.hasOwn(definitions, name)) return reject("dangling_ref", at);
      if (stack.includes(name)) return reject("cyclic_ref", at);
      return walk(definitions[name], at, [...stack, name]);
    }
    const result: Json = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$defs") continue;
      if (key === "properties" && isObject(value)) {
        const properties: Json = {};
        for (const [name, property] of Object.entries(value)) {
          const walked = walk(property, [...at, "properties", name], stack);
          if (Result.isFailure(walked)) return walked;
          properties[name] = walked.success;
        }
        result.properties = properties;
      } else if (key === "items" || (COMBINATORS.includes(key as (typeof COMBINATORS)[number]) && Array.isArray(value))) {
        const members = Array.isArray(value) ? value : [value];
        const walked: unknown[] = [];
        for (const [i, member] of members.entries()) {
          const w = walk(member, Array.isArray(value) ? [...at, key, String(i)] : [...at, key], stack);
          if (Result.isFailure(w)) return w;
          walked.push(w.success);
        }
        result[key] = Array.isArray(value) ? walked : walked[0];
      } else {
        result[key] = value;
      }
    }
    if (result.type === "object" && result.properties !== undefined) {
      result.required = Object.keys(result.properties as Json);
      result.additionalProperties = false;
    }
    return Result.succeed(result);
  };
  const walked = walk(json, [], []);
  return Result.isSuccess(walked) ? Result.succeed(walked.success as Json) : Result.fail(walked.failure);
};

/** The variant that the acceptance proof of plan step 0.4 selected (prototypes/.../CHOSEN: raw). */
export const agentJsonSchema = (schema: Schema.Top): Json => rawJsonSchema(schema);
