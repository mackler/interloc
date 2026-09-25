import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { Result } from "effect";
import { agentJsonSchema, rawJsonSchema, strictJsonSchema, type Json } from "../src/jsonSchema.ts";
import * as S from "../src/schema.ts";
import * as legacy from "./fixtures/legacy-schemas.ts";

// The seven schemas that an agent call passes as its output schema.
const agentSchemas = {
  review: { effect: S.Review, legacy: legacy.reviewSchema },
  plannerResponse: { effect: S.PlannerResponse, legacy: legacy.plannerResponseSchema },
  planWrite: { effect: S.PlanWriteResult, legacy: legacy.planWriteSchema },
  execReport: { effect: S.ExecReport, legacy: legacy.execReportSchema },
  questionList: { effect: S.QuestionList, legacy: legacy.questionListSchema },
  questionListResponse: { effect: S.QuestionListResponse, legacy: legacy.questionListResponseSchema },
  interviewTurn: { effect: S.InterviewTurn, legacy: legacy.interviewTurnSchema },
};

const proven = (name: string, variant: "raw" | "strict"): Json =>
  JSON.parse(fs.readFileSync(new URL(`../prototypes/proto-schema-output/${name}.${variant}.json`, import.meta.url), "utf8"));
const chosen = fs.readFileSync(new URL("../prototypes/proto-schema-output/CHOSEN", import.meta.url), "utf8").trim() as "raw" | "strict";
/** The strict variant, which every agent schema supports (finding 24: the transform is total and typed). */
const strict = (json: Json): Json => {
  const result = strictJsonSchema(json);
  assert.ok(Result.isSuccess(result), `the strict transform rejected the schema: ${JSON.stringify(Result.isFailure(result) ? result.failure : null)}`);
  return result.success;
};

test("the strict transform closes every object and requires every key", () => {
  const input: Json = {
    type: "object",
    properties: {
      open: { type: "object", properties: { a: { type: "string" } } },
      list: { type: "array", items: { $ref: "#/$defs/Entry" } },
    },
    required: ["open"],
    $defs: { Entry: { type: "object", properties: { b: { type: "number" } } } },
  };
  assert.deepEqual(strict(input), {
    type: "object",
    properties: {
      open: { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false },
      list: { type: "array", items: { type: "object", properties: { b: { type: "number" } }, required: ["b"], additionalProperties: false } },
    },
    required: ["open", "list"],
    additionalProperties: false,
  });
});

test("the agent schemas have the shape of the legacy schemas", () => {
  for (const [name, { effect, legacy: old }] of Object.entries(agentSchemas)) {
    assert.deepEqual(strict(rawJsonSchema(effect)), strict(old as Json), `${name} differs from the legacy schema`);
  }
});

test("the production schemas generate exactly what the prototype proved", () => {
  for (const [name, { effect }] of Object.entries(agentSchemas)) {
    assert.deepEqual(rawJsonSchema(effect), proven(name, "raw"), `${name} raw`);
    assert.deepEqual(strict(rawJsonSchema(effect)), proven(name, "strict"), `${name} strict`);
  }
});

test("agents receive the variant proven in the prototype", () => {
  for (const [name, { effect }] of Object.entries(agentSchemas)) {
    assert.deepEqual(agentJsonSchema(effect), proven(name, chosen), `${name} is not the ${chosen} variant`);
  }
});

// Finding 24: a reference the transform cannot resolve is a typed rejection, not `undefined` or a stack overflow.
test("a missing $ref is a dangling_ref rejection naming the path, and a cyclic definition terminates with cyclic_ref", () => {
  const dangling = strictJsonSchema({ type: "object", properties: { a: { $ref: "#/$defs/Missing" } }, $defs: {} });
  assert.ok(Result.isFailure(dangling));
  assert.deepEqual(dangling.failure, { reason: "dangling_ref", at: "properties.a" });
  const cyclic = strictJsonSchema({ type: "object", properties: { a: { $ref: "#/$defs/Node" } }, $defs: { Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } } } });
  assert.ok(Result.isFailure(cyclic));
  assert.equal(cyclic.failure.reason, "cyclic_ref");
  const siblings = strictJsonSchema({ type: "object", properties: { a: { $ref: "#/$defs/E", description: "d" } }, $defs: { E: { type: "string" } } });
  assert.ok(Result.isFailure(siblings));
  assert.equal(siblings.failure.reason, "ref_with_siblings");
});
