// S9 and S10 (decision Q1, G-R1-1): a fresh Claude Code session writes the context paragraph and the terms of a
// question the program composed; the reply is held to the rules of every question with the repair turns of
// behaviour 10, and a call that cannot succeed leaves the program's own paragraph, so that the question is asked.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { askOffering, numberedOptions, type QuestionDraft } from "../src/offer.ts";
import * as prompts from "../src/prompts.ts";
import { writeContext } from "../src/questionContext.ts";
import { Store, Ui } from "../src/services.ts";
import { presentedQuestions, SCRIPTED_CONTEXT, tempRepo, testLayer, type TestOptions } from "./helpers.ts";

const origin = { kind: "permission", tool: "Bash", input: "npm install zod" } as const;
const request: prompts.ContextRequest = {
  origin,
  decision: null,
  question: "Should Claude Code be allowed to install zod?",
  options: [{ label: "Allow", description: "zod is installed." }, { label: "Deny", description: "Nothing is installed." }],
  details: "",
  facts: "The command npm install zod adds the library zod to the project.",
};
const good = {
  context: "Claude Code, the coding agent, is carrying out the plan in this project. It wants to run a command that installs zod, a library, now, while the plan's work waits, so that it can check the input of a tool.",
  terms: [{ term: "zod", explanation: "A library that checks that data has the shape a program expects." }],
};
/** The services over a repository whose records are initialized, as at the start of a run. */
const initialized = (options: TestOptions) => {
  const t = testLayer(tempRepo(), options);
  return t;
};
const run = (options: TestOptions) => {
  const { probe, layer } = initialized(options);
  return {
    probe,
    written: () => Effect.runPromise(Effect.gen(function* () {
      yield* (yield* Store).init("the task");
      return yield* writeContext("the task", request);
    }).pipe(Effect.provide(layer))),
  };
};
const conversation = (dir: string) => fs.readFileSync(path.join(dir, "conversation.md"), "utf8");

test("the context call is a read-only call in a fresh session, with the rules, the task, the facts and the fixed question", async () => {
  const { probe, written } = run({ contexts: [{ output: good }] });
  assert.deepEqual(await written(), { context: { text: good.context, by: "agent" }, terms: good.terms });
  assert.equal(probe.planner.freshSessions, 1);
  assert.equal(probe.planner.contextPrompts.length, 1);
  const prompt = probe.planner.contextPrompts[0];
  assert.ok(prompt.includes(prompts.questionWritingRules()));
  for (const part of ["the task", request.question, request.facts, prompts.optionLine(0, request.options[0]), prompts.originLine(origin, null)]) assert.ok(prompt.includes(part), part);
  assert.deepEqual(probe.planner.prompts, [], "the other calls' scripts are untouched");
});

test("a reply that does not match the schema gets its repair turn; a reply that breaks a rule gets the validation repair turn", async () => {
  const schema = run({ contexts: [{ output: { context: 1 } }, { output: good }] });
  assert.equal((await schema.written()).context.by, "agent");
  assert.equal(schema.probe.planner.contextPrompts.length, 2);
  const absent = { ...good, terms: [{ term: "Zod", explanation: "A library." }] };
  const rule = run({ contexts: [{ output: absent }, { output: good }] });
  assert.equal((await rule.written()).context.by, "agent");
  assert.equal(rule.probe.planner.contextPrompts[1], prompts.questionRepairPrompt([{ where: "the context of the question", problems: [{ kind: "termAbsent", subject: "Zod" }] }]));
});

test("S10: a second invalid reply leaves the program's own paragraph, with a note in conversation.md", async () => {
  const blank = { ...good, context: " " };
  const { probe, written } = run({ contexts: [{ output: blank }, { output: blank }] });
  assert.deepEqual(await written(), { context: { text: prompts.fallbackContext(origin), by: "program" }, terms: [] });
  assert.match(conversation(probe.dir), /\*\*Context written by Interloq:\*\*/);
});

test("S9: a question that asks for its context is presented with the agent's paragraph and terms", async () => {
  const { layer, probe } = initialized({ answers: ["1"], contexts: [{ output: good }] });
  const draft: QuestionDraft = { origin, context: { text: "", by: "program" }, terms: [], question: request.question, options: numberedOptions(request.options), explain: request.facts, decision: null };
  const ask = Effect.gen(function* () {
    yield* (yield* Store).init("the task");
    const ui = yield* Ui;
    return yield* askOffering((p) => ui.ask(p), prompts.permissionPrompt, draft);
  });
  await Effect.runPromise(ask.pipe(Effect.provide(layer)));
  const [q] = presentedQuestions(probe.ui);
  assert.deepEqual(q.context, { text: good.context, by: "agent" });
  assert.deepEqual(q.terms, good.terms);
  // Without a scripted reply, a context call returns the scripted default, which keeps the rules.
  const scripted = initialized({ answers: ["1"] });
  await Effect.runPromise(ask.pipe(Effect.provide(scripted.layer)));
  assert.equal(presentedQuestions(scripted.probe.ui)[0].context.text, SCRIPTED_CONTEXT.context);
});

test("S10: a context call whose retries are exhausted asks nothing of its own; the program's paragraph stands", async () => {
  const fault = { fault: "read ECONNRESET" };
  const { probe, written } = run({ contexts: [fault, fault], config: { maxTransportRetries: 1, transportRetryDelaySeconds: 0.01 } });
  assert.deepEqual(await written(), { context: { text: prompts.fallbackContext(origin), by: "program" }, terms: [] });
  assert.equal(probe.planner.contextPrompts.length, 2, "one call and one retry");
  assert.deepEqual(probe.ui.asked, [], "no exhaustion pause was asked");
  assert.deepEqual(presentedQuestions(probe.ui), []);
  assert.match(conversation(probe.dir), /\*\*Context written by Interloq:\*\*.*could not be reached/);
});

// S33 (W1-R1-1): the context call reads the project and writes nothing: its own capability, with the records guard.
test("the context call is made with the readProject capability", async () => {
  const { probe, written } = run({ contexts: [{ output: good }] });
  await written();
  assert.deepEqual(probe.planner.contextCapabilities, ["readProject"]);
});

test("a context call that changes a guarded record halts with RecordsChanged; the fallback does not catch it", async () => {
  const { written } = run({ contexts: [{ output: good, editRecord: { file: "foreign.md", content: "x" } }] });
  await assert.rejects(written(), (e: unknown) => (e as { _tag?: string })._tag === "RecordsChanged");
});

test("a context call that changes the project halts with ProjectChanged; the fallback does not catch it", async () => {
  const { written } = run({ contexts: [{ output: good, touchProject: true }] });
  await assert.rejects(written(), (e: unknown) => (e as { _tag?: string })._tag === "ProjectChanged");
});

// S36 (W1-R1-4): a term must occur in what the user is shown, not only in the facts the context call is given.
test("a term found only in the hidden facts gets the repair turn; one in the displayed details passes; the prompt says so", async () => {
  const onlyInFacts = { ...good, terms: [{ term: "npm", explanation: "The package manager of Node.js." }] };
  const hidden = run({ contexts: [{ output: onlyInFacts }, { output: good }] });
  await hidden.written();
  assert.equal(hidden.probe.planner.contextPrompts[1], prompts.questionRepairPrompt([{ where: "the context of the question", problems: [{ kind: "termAbsent", subject: "npm" }] }]));
  const { contextValidation } = await import("../src/questionContext.ts");
  const { Result } = await import("effect");
  assert.ok(Result.isSuccess(contextValidation({ ...request, details: "The command: npm install zod" })(onlyInFacts)));
  assert.ok(Result.isFailure(contextValidation(request)(onlyInFacts)));
  assert.ok(prompts.contextPrompt("t", request).includes(prompts.CONTEXT_TERMS_RULE));
});
