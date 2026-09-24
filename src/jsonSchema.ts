// The JSON Schema that the agents receive, derived from the Effect schemas of src/schema.ts, so
// that type, JSON Schema and validation have one source. API names: docs/effect-v4-api.md.
//
// Both agents accept the generated schema as it is: the proof of plan step 0.4 (run.txt in
// prototypes/proto-schema-output/) shows 28 accepted calls, and `onExcessProperty: "error"` already
// yields `additionalProperties: false` with a complete `required` list. `strictJsonSchema` is the
// fallback for a future Effect version that generates something looser, and `agentJsonSchema`
// selects the variant that the proof recorded.

import { Schema } from "effect";

export type Json = Record<string, unknown>;

/** The generated JSON Schema. `definitions` becomes `$defs`, so that a `$ref` can be resolved. */
export const rawJsonSchema = (schema: Schema.Top): Json => {
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" });
  const definitions = document.definitions as Json;
  const json = document.schema as Json;
  return Object.keys(definitions).length > 0 ? { ...json, $defs: definitions } : json;
};

/**
 * Every object gets `additionalProperties: false` and `required` = all of its property keys, and
 * every `$ref` is replaced by the definition it names. Codex's strict structured output requires
 * both; an optional key cannot survive this transform, and none of the agent schemas has one.
 */
export const strictJsonSchema = (json: Json): Json => {
  const definitions = (json.$defs ?? {}) as Json;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== "object") return node;
    const source = node as Json;
    if (typeof source.$ref === "string") return walk(definitions[source.$ref.replace("#/$defs/", "")]);
    const result: Json = {};
    for (const [key, value] of Object.entries(source)) if (key !== "$defs") result[key] = walk(value);
    if (result.type === "object" && result.properties !== undefined) {
      result.required = Object.keys(result.properties as Json);
      result.additionalProperties = false;
    }
    return result;
  };
  return walk(json) as Json;
};

/** The variant that the acceptance proof of plan step 0.4 selected (prototypes/.../CHOSEN: raw). */
export const agentJsonSchema = (schema: Schema.Top): Json => rawJsonSchema(schema);
