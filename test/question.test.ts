// S2: validateQuestion checks the mechanical part of QUESTION_RULES, and its repair prompt cites the rules it found broken,
// from the same array the writing prompts are rendered from (rules for changes: a prompt and its validation together).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Result } from "effect";
import { decodeRunError, haltMessage } from "../src/errors.ts";
import * as prompts from "../src/prompts.ts";
import { type Question, questionProblems, termOccurrences, validateQuestion, validateQuestions } from "../src/question.ts";

const good: Question = {
  context: "Interloq, the orchestrator, runs Claude Code, a coding agent, when a phase begins; zod, a validation library, checks what it returns.",
  question: "The input of a tool is described with zod. Should zod be declared as a dependency?",
  terms: [{ term: "zod", explanation: "A library that checks that data has the expected shape." }],
  options: [
    { label: "Declare zod", description: "Add zod to package.json." },
    { label: "Leave it", description: "Keep it as a dependency of the SDK only." },
  ],
};
const kinds = (q: Question) => questionProblems(q).map((p) => p.kind);

test("a question that keeps every mechanical rule passes", () => {
  assert.deepEqual(questionProblems(good), []);
  assert.ok(Result.isSuccess(validateQuestion(good)));
});

test("an empty context, a question that does not end with its interrogative sentence, and a bare number are found", () => {
  assert.deepEqual(kinds({ ...good, context: "  " }), ["blankContext"]);
  assert.deepEqual(kinds({ ...good, question: "Should zod be declared? It is used by the SDK." }), ["notLast"]);
  assert.deepEqual(kinds({ ...good, context: `${good.context} See #53.` }), ["bareNumber"]);
  assert.deepEqual(questionProblems({ ...good, options: [{ label: "Later (#14, #6)", description: "" }] }).map((p) => p.subject), ["#14", "#6"]);
});

test("a number with its kind before it is not bare, in a list too", () => {
  for (const text of ["Issue #6 says so.", "Issues #6, #33 and #28 say so.", "As issues #14 or #6 say."]) assert.deepEqual(kinds({ ...good, context: `${good.context} ${text}` }), [], text);
});

test("terms: blank names and explanations, absent and repeated terms are found; an explanation need not occur", () => {
  assert.deepEqual(kinds({ ...good, terms: [{ term: " ", explanation: "x" }] }), ["blankTerm"]);
  assert.deepEqual(kinds({ ...good, terms: [{ term: "zod", explanation: "  " }] }), ["blankExplanation"]);
  assert.deepEqual(kinds({ ...good, terms: [{ term: "Zod", explanation: "A library." }] }), ["termAbsent"]);
  assert.deepEqual(kinds({ ...good, terms: [{ term: "zo", explanation: "Part of a word." }] }), ["termAbsent"]);
  assert.deepEqual(kinds({ ...good, terms: [...good.terms, ...good.terms] }), ["duplicateTerm"]);
  assert.deepEqual(kinds({ ...good, terms: [{ term: "Declare", explanation: "Occurs in an option's label only." }] }), []);
});

test("termOccurrences finds every case-sensitive, whole-word occurrence, phrases and identifiers included", () => {
  assert.deepEqual(termOccurrences("zod, zodiac and zod.", "zod"), [0, 16]);
  assert.deepEqual(termOccurrences("call report_step; report_steps", "report_step"), [5]);
  assert.deepEqual(termOccurrences("a transport fault, then transport faults", "transport fault"), [2]);
  assert.deepEqual(termOccurrences("Zod", "zod"), []);
});

test("every problem kind names a rule of QUESTION_RULES, and the repair prompt cites that rule verbatim", () => {
  for (const kind of prompts.QUESTION_PROBLEM_KINDS) {
    const rule = prompts.QUESTION_RULES.find((r) => r.id === prompts.QUESTION_PROBLEM_RULE[kind]);
    assert.ok(rule !== undefined, kind);
    const repair = prompts.questionRepairPrompt([{ where: "questions_for_user 1", problems: [{ kind, subject: "zod" }] }]);
    assert.ok(repair.includes(rule.rule), kind);
    assert.ok(repair.includes(prompts.questionProblemText({ kind, subject: "zod" })), kind);
  }
});

test("validateQuestions names each failing question and fails with QuestionInvalid, which decodes and halts", () => {
  const result = validateQuestions([
    { where: "questions_for_user 1", question: good },
    { where: "questions_for_user 2", question: { ...good, terms: [{ term: "zod", explanation: "" }] } },
  ]);
  assert.ok(Result.isFailure(result));
  assert.deepEqual(result.failure.questions, [{ where: "questions_for_user 2", problems: [{ kind: "blankExplanation", subject: "zod" }] }]);
  assert.equal(decodeRunError({ ...result.failure })?._tag, "QuestionInvalid");
  assert.match(haltMessage(result.failure) ?? "", /^HALTED: a question for the user is invalid: questions_for_user 2: the term "zod" has an empty explanation\./);
});

test("questionsValidation passes a reply whose questions keep the rules, and fails another with the repair prompt of its problems", async () => {
  const { questionsValidation } = await import("../src/review.ts");
  const validate = questionsValidation((qs: readonly Question[]) => qs.map((question, i) => ({ where: `questions_for_user ${i + 1}`, question })));
  const ok = validate([good]);
  assert.ok(Result.isSuccess(ok));
  assert.deepEqual(ok.success, { value: [good], notes: [] });
  const bad = validate([{ ...good, context: "" }]);
  assert.ok(Result.isFailure(bad));
  assert.equal(bad.failure.error._tag, "QuestionInvalid");
  assert.equal(bad.failure.repair, prompts.questionRepairPrompt([{ where: "questions_for_user 1", problems: [{ kind: "blankContext", subject: "" }] }]));
});

// S13 (G-R1-2): a question Claude Code relays through AskUserQuestion carries its context and terms in its text, in the
// shape executePrompt states; the parser reads what the prompt describes, both from RELAYED_SHAPE of src/prompts.ts.
test("the relayed shape: executePrompt states it with the rules, and parseRelayedQuestion reads what it states", async () => {
  const { parseRelayedQuestion } = await import("../src/question.ts");
  assert.ok(prompts.executePrompt.includes(prompts.RELAYED_SHAPE));
  assert.ok(prompts.executePrompt.includes(prompts.questionWritingRules()));
  const parts = { context: good.context, terms: good.terms, question: good.question };
  const text = prompts.relayedQuestionText(parts);
  assert.ok(prompts.RELAYED_SHAPE.includes(prompts.relayedQuestionText({ context: "<context>", terms: [{ term: "<term>", explanation: "<explanation>" }], question: "<question>" })), "the prompt's example is the composer's");
  assert.deepEqual(parseRelayedQuestion(text, good.options), { ...parts, options: good.options });
  // Without terms the block may be left out; several paragraphs of context stay together.
  assert.deepEqual(parseRelayedQuestion(`First part.\n\nSecond part.\n\n${good.question}`, [])?.context, "First part.\n\nSecond part.");
  assert.equal(parseRelayedQuestion(`${good.context}\n\n${good.question}`, good.options)?.terms.length, 0);
});

test("a relayed text that does not follow the shape or breaks a rule is not read as one", async () => {
  const { parseRelayedQuestion } = await import("../src/question.ts");
  assert.equal(parseRelayedQuestion(good.question, good.options), null, "no context");
  assert.equal(parseRelayedQuestion(`${good.context}\n\nShould zod be declared as a dependency? It is used by the SDK.`, good.options), null, "the question is not last");
  assert.equal(parseRelayedQuestion(prompts.relayedQuestionText({ context: good.context, terms: [{ term: "Zod", explanation: "a library" }], question: good.question }), good.options), null, "a term that does not occur");
  assert.equal(parseRelayedQuestion(`${good.context}\n\n${prompts.TERMS_HEADING}\nzod\n\n${good.question}`, good.options), null, "a term without its explanation");
});
