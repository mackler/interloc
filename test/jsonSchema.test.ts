import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
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
  assert.deepEqual(strictJsonSchema(input), {
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
    assert.deepEqual(strictJsonSchema(rawJsonSchema(effect)), strictJsonSchema(old as Json), `${name} differs from the legacy schema`);
  }
});

test("the production schemas generate exactly what the prototype proved", () => {
  for (const [name, { effect }] of Object.entries(agentSchemas)) {
    assert.deepEqual(rawJsonSchema(effect), proven(name, "raw"), `${name} raw`);
    assert.deepEqual(strictJsonSchema(rawJsonSchema(effect)), proven(name, "strict"), `${name} strict`);
  }
});

test("agents receive the variant proven in the prototype", () => {
  for (const [name, { effect }] of Object.entries(agentSchemas)) {
    assert.deepEqual(agentJsonSchema(effect), proven(name, chosen), `${name} is not the ${chosen} variant`);
  }
});
