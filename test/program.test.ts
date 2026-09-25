import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Effect, Exit, Fiber } from "effect";
import { exitCodeOf, program, type Wiring } from "../src/program.ts";
import { finished, tempRepo, testWiring, type WiringProbe } from "./helpers.ts";

const noQuestions = { questions_for_user: [] };
const runProgram = (args: readonly string[], wiring: Wiring): Promise<number> => Effect.runPromise(Effect.scoped(program(args, wiring)));
const said = (probe: WiringProbe): string => probe.ui.said.join("\n");

/** The lines every ending prints last: the Claude Code session id and the usage summary. */
const assertTail = (probe: WiringProbe): void => {
  const lines = probe.ui.said.flatMap((text) => text.split("\n"));
  assert.match(lines.at(-2) ?? "", /^Claude Code session id: /);
  assert.match(lines.at(-1) ?? "", /^Usage: /);
};

test("a finished run prints the plan path and exits 0", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }], execs: [finished] });
  assert.equal(await runProgram(["task"], wiring), 0);
  assert.match(said(probe), /Claude Code reports that the task is finished after 1 execution phase\(s\)\./);
  assert.match(said(probe), new RegExp(`Plan: ${path.join(probe.dir, "plan.md")}\\nConversation record: ${probe.dir}/conversation.md`));
  assert.match(said(probe), /Claude Code session id: test-session/);
  assertTail(probe);
});

test("a halt prints HALTED and the reason, the session id and the usage, and exits 1", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ output: noQuestions }] });
  assert.equal(await runProgram(["task"], wiring), 1);
  assert.match(said(probe), /HALTED: Claude Code did not write plan-review\/plan\.md\nState is preserved in .*plan-review\./);
  assertTail(probe);
});

test("the project directory argument is used, and the config of that project applies", async () => {
  const repo = tempRepo();
  const { wiring, probe } = testWiring(repo, { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }], execs: [finished], config: { maxRounds: 3 } });
  assert.equal(await runProgram(["task", repo], { ...wiring, cwd: "/nonexistent" }), 0);
  assert.match(said(probe), /round 1 \(limit 3\)/);
});

test("a missing task prints the usage and exits 2", async () => {
  const { wiring, probe } = testWiring(tempRepo());
  assert.equal(await runProgram([], wiring), 2);
  assert.match(probe.usageLines[0] ?? "", /^usage: node main\.ts "task description" \[project directory\]$/);
  assert.deepEqual(probe.ui.said, []);
});

test("an invalid config prints HALTED with the file and field and exits 1, before any agent call and without records", async () => {
  const repo = tempRepo();
  const { wiring, probe } = testWiring(repo, { steps: [{ output: noQuestions, plan: "v1" }] });
  fs.writeFileSync(path.join(probe.dir, "config.json"), JSON.stringify({ maxRounds: "5" }));
  assert.equal(await runProgram(["task"], wiring), 1);
  assert.match(said(probe), /HALTED: .*plan-review\/config\.json is not a valid configuration: Expected number \(at maxRounds\)/);
  assert.match(said(probe), /Claude Code session id: none/);
  assertTail(probe);
  assert.deepEqual(probe.planner.prompts, []);
  assert.ok(!fs.existsSync(path.join(probe.dir, "conversation.md")), "the records were initialised");
});

/** Runs the program in a fiber, waits for the double to be reached, interrupts it, and returns its exit. */
const interruptWhen = async (wiring: Wiring, reached: Promise<void>): Promise<Exit.Exit<number, never>> => {
  const fiber = Effect.runFork(Effect.scoped(program(["task"], wiring)));
  await Promise.race([reached, sleep(5000).then(() => assert.fail("the program did not reach the point to interrupt within 5 s"))]);
  await sleep(10);
  await Effect.runPromise(Fiber.interrupt(fiber));
  return Effect.runPromise(Fiber.await(fiber));
};

const assertInterrupted = (probe: WiringProbe, exit: Exit.Exit<number, never>): void => {
  assert.equal(exitCodeOf(exit), 130);
  assert.match(said(probe), /INTERRUPTED by the user\. State is preserved in .*plan-review\./);
  assert.match(fs.readFileSync(path.join(probe.dir, "conversation.md"), "utf8"), /\*\*Interrupted by the user\.\*\*\n$/);
  assertTail(probe);
};

test("interrupt while the UI waits for input", async () => {
  const { wiring, probe } = testWiring(tempRepo(), {
    answers: [{ wait: true }],
    steps: [{ output: noQuestions, plan: "v1" }],
    reviews: [{ issues: [] }],
    execs: [{ status: "aborted", summary: "", question: "no status", remainingWork: "", userInput: null }],
  });
  const exit = await interruptWhen(wiring, probe.ui.nextAsk());
  assertInterrupted(probe, exit);
});

test("interrupt while a scripted agent call is pending", async () => {
  const { wiring, probe } = testWiring(tempRepo(), { steps: [{ hang: true }] });
  const exit = await interruptWhen(wiring, probe.planner.nextHang());
  assertInterrupted(probe, exit);
  assert.equal(probe.planner.hangSignals[0].aborted, true, "the pending call was not aborted");
});

test("exitCodeOf: the program's own code, 130 for an interruption, 1 for a defect", () => {
  assert.equal(exitCodeOf(Exit.succeed(0)), 0);
  assert.equal(exitCodeOf(Exit.succeed(2)), 2);
  assert.equal(exitCodeOf(Exit.interrupt(1)), 130);
  assert.equal(exitCodeOf(Exit.die(new Error("x"))), 1);
});
