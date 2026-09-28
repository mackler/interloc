// The server of the end-to-end tests (plan step 5.1): the real web server and run manager over the scripted
// agents of test/helpers.ts, in a temporary repository, so that no agent is reached. SCENARIO chooses the script
// of every run: "converge" (one accepted issue, then convergence), "decision" (a question from Claude Code),
// "stop" (a planning call that waits until it is interrupted), and those of finding 10 of docs/gui-review.md:
// "interview", "workCorrection", "tabs", "drop", "long"; and "questionReview", the question phase whose review raises
// an issue, so that Claude Code's response carries the amended list (defect A of docs/page-question-phase-defects.md);
// "longChoices", an interview turn whose numbered answers are paragraphs (issue #12).
// PORT is the port.

import { Effect } from "effect";
import { HttpServer } from "effect/unstable/http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { platformLayer } from "../src/platform.ts";
import { makeRunManager } from "../src/runManager.ts";
import { makeWebServer } from "../src/webServer.ts";
import { LONG_ANSWERS } from "./longAnswers.ts";
import { finished, issue, respond, type TestOptions, tempRepo, testWiring } from "../test/helpers.ts";

const noQuestions = { questions_for_user: [] };
/** A scripted interview turn; `asked` and `answered` are the ids Claude reports (issue #21). */
const turn = (message: string, complete: boolean, summary: string, asked: string[] = [], answered: string[] = []) => ({ message_to_user: message, asked_ids: asked, answered_ids: answered, complete, summary });
const LONG = 60;
export const SCENARIOS: Record<string, TestOptions> = {
  converge: {
    steps: [{ output: noQuestions, plan: "1. [ ] the step\n" }, { output: respond([["P1-R1-1", "accepted"]]), plan: "1. [ ] the step, amended\n" }],
    reviews: [{ issues: [issue("P1-R1-1", "The step names no file.")] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  },
  decision: {
    steps: [{ output: { questions_for_user: [{ question: "Which database should the service use?", options: [] }] }, plan: "1. [ ] the step\n" }, { output: noQuestions }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
  },
  stop: { steps: [{ output: noQuestions, plan: "1. [ ] the step\n" }, { hang: true }], reviews: [{ issues: [issue("P1-R1-1")] }] },
  // Finding 10 of docs/gui-review.md: the scenarios the review names.
  // The question phase: a question list, an interview message, /done, a proposed summary and its confirmation.
  interview: {
    config: { questionPhase: true },
    steps: [
      { output: { questions: [{ id: "Q1", question: "Which database?", reason: "r", proposed_answers: [{ label: "PostgreSQL", description: "p" }, { label: "SQLite", description: "s" }], default_answer: "PostgreSQL" }] } },
      { output: turn("Which database should the service use?\n1. PostgreSQL\n2. SQLite", false, "", ["Q1"]) },
      { output: turn("Anything else?", false, "", ["Q1"], ["Q1"]) },
      { output: turn("That is all I need.", true, "# Requirements\n\nThe service uses PostgreSQL.", ["Q1"], ["Q1"]) },
      { output: noQuestions, plan: "1. [ ] the step\n" },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  },
  // Issue #12: the interview's numbered answers are paragraphs.
  longChoices: {
    config: { questionPhase: true },
    steps: [
      { output: { questions: [{ id: "Q1", question: "How should a message show its time?", reason: "r", proposed_answers: [{ label: "Absolute", description: "a" }, { label: "Relative", description: "r" }], default_answer: "Absolute" }] } },
      { output: turn(`How should a message show its time?\n${LONG_ANSWERS.join("\n")}`, false, "", ["Q1"]) },
      { output: turn("Anything else?", false, "") },
      { output: turn("That is all I need.", true, "# Requirements\n\nRelative time.") },
      { output: noQuestions, plan: "1. [ ] the step\n" },
    ],
    reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  },
  // Defect A of docs/page-question-phase-defects.md: the question list, its review with one issue, Claude Code's
  // response with the amended list, a second round without an issue, one interview turn with numbered answers, the
  // user's answer, a summary, the requirements review, then planning, execution and the work review.
  questionReview: {
    config: { questionPhase: true },
    steps: [
      { output: { questions: [{ id: "Q1", question: "Which database?", reason: "r", proposed_answers: [{ label: "PostgreSQL", description: "p" }, { label: "SQLite", description: "s" }], default_answer: "PostgreSQL" }] } },
      {
        output: {
          ...respond([["Q-R1-1", "accepted"]]),
          questions: [
            { id: "Q1", question: "Which database?", reason: "r", proposed_answers: [{ label: "PostgreSQL", description: "p" }, { label: "SQLite", description: "s" }], default_answer: "PostgreSQL" },
            { id: "Q2", question: "Which port?", reason: "r", proposed_answers: [{ label: "8080", description: "p" }], default_answer: "8080" },
          ],
        },
      },
      { output: turn("Which database should the service use?\n1. PostgreSQL\n2. SQLite", false, "") },
      { output: turn("That is all I need.", true, "# Requirements\n\nThe service uses PostgreSQL on port 8080.") },
      { output: noQuestions, plan: "1. [ ] the step\n" },
    ],
    reviews: [{ issues: [issue("Q-R1-1", "The list does not ask for the port.")] }, { issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
    execs: [finished],
  },
  // A work correction: work review 1 raises an issue that Claude Code accepts, so planning, execution and the work
  // review run a second time, and the second work review converges.
  workCorrection: {
    steps: [{ output: noQuestions, plan: "1. [ ] the step\n" }, { output: respond([["W1-R1-1", "accepted"]]) }, { output: noQuestions, plan: "1. [x] the step\n2. [ ] the fix\n" }],
    reviews: [{ issues: [] }, { issues: [issue("W1-R1-1", "The step misses its test.")] }, { issues: [] }, { issues: [] }],
    execs: [finished, finished],
  },
  // Two decisions in a row, for two tabs and a dropped connection.
  tabs: {
    steps: [{ output: { questions_for_user: [{ question: "Which database should the service use?", options: [] }, { question: "Which cache should the service use?", options: [] }] }, plan: "1. [ ] the step\n" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
  },
  drop: {
    steps: [{ output: { questions_for_user: [{ question: "Which database should the service use?", options: [] }] }, plan: "1. [ ] the step\n" }],
    reviews: [{ issues: [] }, { issues: [] }],
    execs: [finished],
  },
  // A long transcript: 60 accepted rounds, then two rounds without an acceptance and the idle pause, which waits.
  long: {
    config: { maxRounds: 100, maxIdleRounds: 2 },
    steps: [
      { output: noQuestions, plan: "v0\n" },
      ...Array.from({ length: LONG }, (_, i) => ({ output: respond([[`P1-R${i + 1}-1`, "accepted"]]), plan: `v${i + 1}\n`, resultText: `Round ${i + 1}: the plan now covers point ${i + 1} in detail. `.repeat(4) })),
      { output: respond([[`P1-R${LONG + 1}-1`, "rejected"]]) },
      { output: respond([[`P1-R${LONG + 2}-1`, "rejected"]]) },
    ],
    reviews: [
      ...Array.from({ length: LONG + 2 }, (_, i) => ({ issues: [issue(`P1-R${i + 1}-1`, `Point ${i + 1} of the plan is not specific enough to implement without guessing.`)] })),
      { issues: [] },
      { issues: [] },
    ],
    execs: [finished],
  },
};

const scenario = SCENARIOS[process.env.SCENARIO ?? "converge"] ?? SCENARIOS.converge;
const port = Number(process.env.PORT ?? "8101");
const repo = tempRepo();
const distDir = fileURLToPath(new URL("../web/dist", import.meta.url));

const main = Effect.gen(function* () {
  const manager = yield* makeRunManager((ui) => ({ ...testWiring(repo, scenario).wiring, ui: Effect.succeed(ui) }), repo, `e2e-${process.env.SCENARIO ?? "converge"}`);
  // As src/web.ts: the tabs are closed by a finalizer registered after serveEffect, so it runs first (finding 15).
  const web = yield* makeWebServer(manager, distDir);
  yield* HttpServer.serveEffect(web.handler);
  yield* Effect.addFinalizer(() => web.closeAll);
  yield* Effect.sync(() => void process.stdout.write(`e2e server (${process.env.SCENARIO ?? "converge"}) on http://127.0.0.1:${port}/ in ${repo}\n`));
  return yield* Effect.never;
}).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layer(() => createServer(), { port })), Effect.provide(platformLayer));

NodeRuntime.runMain(main);
