import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { Effect, Layer } from "effect";
import type { Subject } from "../src/review.ts";
import * as S from "../src/schema.ts";
import { Store } from "../src/services.ts";
import { questionSubject } from "../src/subjects.ts";
import { platformLayer } from "../src/platform.ts";
import { makeStore } from "../src/store.ts";
import { tempRepo } from "./helpers.ts";

// Finding 12 of docs/functional-design-review.md: a subject's decoded output and its handler share one type.

test("the type of a subject's handler follows the type of its schema (compile-time)", () => {
  const wrong: Subject<S.PlannerResponse, S.QuestionList> = {
    id: "questions",
    heading: "h",
    fileLabel: "f",
    respond: { prompt: () => "p", schema: S.PlannerResponse, after: null },
    // @ts-expect-error the handler must take the decoded type of the operation's schema
    applyDecisions: { prompt: "p", schema: S.QuestionList, after: (output: S.ExecOutcome) => Effect.sync(() => void output) },
    amend: null,
    proceedLabel: "go",
  };
  void wrong;
});

test("the question subject's handlers receive the decoded list and write questions.json", async () => {
  const store = await Effect.runPromise(makeStore(tempRepo(), []).pipe(Effect.provide(platformLayer)));
  await Effect.runPromise(store.init("task"));
  const subject = questionSubject("task");
  const withStore = <A, E>(effect: Effect.Effect<A, E, Store>): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(Layer.succeed(Store, store))));
  const list = { questions: [{ id: "Q1", question: "q?", reason: "r", proposed_answers: [{ label: "A", description: "a" }], default_answer: "A" }] };
  assert.ok(subject.applyDecisions.after !== null && subject.respond.after !== null);
  await withStore(subject.applyDecisions.after(list));
  assert.deepEqual(JSON.parse(fs.readFileSync(store.questions, "utf8")).questions.map((q: { id: string }) => q.id), ["Q1"]);
  await withStore(subject.respond.after({ dispositions: [], self_corrections: [], reviewer_feedback: "", questions_for_user: [], questions: [] }));
  assert.deepEqual(JSON.parse(fs.readFileSync(store.questions, "utf8")).questions, []);
});
