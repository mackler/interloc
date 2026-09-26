import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Effect, Layer, Scope } from "effect";
import { claudePlannerLayer } from "../src/claude.ts";
import { codexReviewerLayer } from "../src/codex.ts";
import { platformLayer } from "../src/platform.ts";
import { program } from "../src/program.ts";
import type { RunEvent } from "../src/protocol.ts";
import { type Broadcast, makeRunManager, type Refusal, type RunManager } from "../src/runManager.ts";
import { numberedChoices } from "../src/userPrompts.ts";
import { FakeSdk, init, messages, success, turn } from "./fakeSdk.ts";
import { finished, type TestOptions, tempDir, tempRepo, testWiring } from "./helpers.ts";
import { NUMBERED_MESSAGE } from "./interviewFixture.ts";

// Plan step 3.3: the run manager with scripted clients over the scripted wiring (and once over the real adapters).
const run = Effect.runPromise;
const noQuestions = { questions_for_user: [] };
type Harness = { manager: RunManager; received: Broadcast[]; scope: Scope.Closeable; repo: string; scripts: TestOptions[] };

/** A manager whose runs use, in turn, the scripted wiring of each options object; a listener collects the broadcast. */
const harness = async (repo: string, scripts: TestOptions[], wiringOf = (options: TestOptions) => testWiring(repo, options).wiring): Promise<Harness> => {
  const queue = [...scripts];
  const manager = await run(makeRunManager((ui) => ({ ...wiringOf(queue.shift() ?? {}), ui: Effect.succeed(ui) }), repo).pipe(Effect.provide(platformLayer)));
  const received: Broadcast[] = [];
  const scope = await run(Scope.make());
  await run(manager.subscribe((b) => Effect.sync(() => void received.push(b))).pipe(Scope.provide(scope)));
  return { manager, received, scope, repo, scripts };
};
const until = async (what: string, condition: () => boolean, ms = 5000): Promise<void> => {
  for (let waited = 0; waited < ms; waited += 5) {
    if (condition()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const eventsOf = (h: Harness, id: number): RunEvent[] => h.received.filter((b) => b.run === id).map((b) => b.event);
const ended = (h: Harness, id: number) => until(`the end of run ${id}`, () => eventsOf(h, id).some((e) => e._tag === "Ended"));
const endCode = (h: Harness, id: number): number | undefined => eventsOf(h, id).flatMap((e) => (e._tag === "Ended" ? [e.code] : []))[0];
const started = async (h: Harness, project: string, task = "task"): Promise<number> => {
  const id = await run(h.manager.start(project, task));
  assert.equal(typeof id, "number", `refused: ${(id as Refusal).refused}`);
  return id as number;
};
const pendingAsk = async (h: Harness, id: number) => {
  let asked: Extract<RunEvent, { _tag: "Asked" }> | undefined;
  await until("a prompt", () => {
    const events = eventsOf(h, id);
    const last = [...events].reverse().find((e) => e._tag === "Asked" || e._tag === "Answered");
    asked = last?._tag === "Asked" ? last : undefined;
    return asked !== undefined;
  });
  return asked!;
};
const converging: TestOptions = { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] };

test("a run: Started, the Ui's events, Ended 0; conversation.md is byte-identical to a terminal run of the same script", async () => {
  const terminal = tempRepo();
  const { wiring } = testWiring(terminal, converging);
  assert.equal(await run(Effect.scoped(program(["task", terminal], wiring))), 0);

  const repo = tempRepo();
  const h = await harness(repo, [converging]);
  const id = await started(h, repo);
  await ended(h, id);
  const events = eventsOf(h, id);
  assert.equal(events[0]._tag, "Started");
  assert.deepEqual(h.received.filter((b) => b.run === id).map((b) => b.seq), events.map((_, i) => i), "seq counts from 0 without a gap");
  assert.equal(endCode(h, id), 0);
  assert.ok(events.some((e) => e._tag === "Said" && /finished after 1 execution phase/.test(e.text)));
  assert.ok(events.some((e) => e._tag === "Notified" && e.event._tag === "PhaseBegan"));
  const read = (r: string) => fs.readFileSync(path.join(r, "plan-review", "conversation.md"), "utf8");
  assert.equal(read(repo), read(terminal));
  assert.equal(await run(h.manager.current), null);
});

test("a question is answered through the manager, with the same text the terminal would send", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [{ steps: [{ output: { questions_for_user: ["Which database?"] }, plan: "v1" }, { output: noQuestions }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] }]);
  const id = await started(h, repo);
  const asked = await pendingAsk(h, id);
  assert.equal(asked.kind, "decision");
  assert.equal(await run(h.manager.answer(id, asked.prompt, "PostgreSQL")), null);
  await ended(h, id);
  assert.match(fs.readFileSync(path.join(repo, "plan-review", "user-decisions.md"), "utf8"), /Which database\?\nDecision: PostgreSQL/);
});

test("start while a run is active is refused; a bad project path is refused with the reason", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [{ steps: [{ hang: true }] }]);
  const id = await started(h, repo);
  await until("the hanging call", () => eventsOf(h, id).some((e) => e._tag === "Said" && /Planning phase 1/.test(e.text)));
  const refusedStart = (await run(h.manager.start(repo, "second"))) as Refusal;
  assert.match(refusedStart.refused, /a run is in progress/);
  await run(h.manager.stop(id));
  await ended(h, id);
  const missing = (await run(h.manager.start(path.join(repo, "nope"), "t"))) as Refusal;
  assert.match(missing.refused, /does not exist/);
  const file = path.join(repo, "a.txt");
  assert.match(((await run(h.manager.start(file, "t"))) as Refusal).refused, /not a directory/);
  assert.match(((await run(h.manager.start(tempDir("pr-plain-"), "t"))) as Refusal).refused, /not a git repository/);
});

test("stop interrupts the run like Ctrl+C; answers and stops naming an ended run are refused; a new run gets a new id", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [{ steps: [{ output: { questions_for_user: ["Which?"] }, plan: "v1" }] }, converging]);
  const first = await started(h, repo);
  const asked = await pendingAsk(h, first);
  assert.equal(await run(h.manager.stop(first)), null);
  await ended(h, first);
  assert.equal(endCode(h, first), 130);
  assert.ok(eventsOf(h, first).some((e) => e._tag === "Said" && /INTERRUPTED by the user\. State is preserved in/.test(e.text)));
  assert.match(fs.readFileSync(path.join(repo, "plan-review", "conversation.md"), "utf8"), /\*\*Interrupted by the user\.\*\*/);
  assert.match(((await run(h.manager.answer(first, asked.prompt, "late"))) as Refusal).refused, /that run has ended/);
  assert.match(((await run(h.manager.stop(first))) as Refusal).refused, /that run has ended/);

  const second = await started(h, repo);
  assert.equal(second, first + 1);
  assert.deepEqual(h.received.find((b) => b.run === second), { run: second, seq: 0, event: eventsOf(h, second)[0] });
  assert.match(((await run(h.manager.answer(first, asked.prompt, "late"))) as Refusal).refused, /that run has ended/);
  await ended(h, second);
  assert.equal(endCode(h, second), 0);
  // After the end, the replay holds the last run only.
  assert.deepEqual((await run(h.manager.replay)).map((r) => r.id), [second]);
});

test("the replay during a run holds the last run and the current one", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [converging, { steps: [{ hang: true }] }]);
  const first = await started(h, repo);
  await ended(h, first);
  const second = await started(h, repo);
  const replay = await run(h.manager.replay);
  assert.deepEqual(replay.map((r) => r.id), [first, second]);
  assert.deepEqual(replay[0].events, eventsOf(h, first));
  await run(h.manager.stop(second));
  await ended(h, second);
});

test("an interview's numbered answer sent through the manager reaches Claude Code as the terminal's text", async () => {
  const repo = tempRepo();
  const turn = (message: string, complete: boolean, summary: string) => ({ message_to_user: message, answered_ids: [], complete, summary });
  const h = await harness(repo, [
    {
      config: { questionPhase: true },
      steps: [{ output: { questions: [] } }, { output: turn(NUMBERED_MESSAGE, false, "") }, { output: turn("Done.", true, "# Requirements\n\nPostgreSQL.") }, { output: noQuestions, plan: "v1" }],
      reviews: [{ issues: [] }, { issues: [] }, { issues: [] }, { issues: [] }],
      execs: [finished],
    },
  ]);
  const id = await started(h, repo);
  const opening = await pendingAsk(h, id);
  assert.equal(opening.kind, "startOrTalk");
  await run(h.manager.answer(id, opening.prompt, "let us talk"));
  const you = await pendingAsk(h, id);
  assert.equal(you.kind, "interviewMessage");
  assert.equal(you.extra, "numberedAnswers");
  const turnEvent = eventsOf(h, id).flatMap((e) => (e._tag === "Notified" && e.event._tag === "InterviewTurn" ? [e.event] : [])).at(-1);
  const choice = numberedChoices(turnEvent?.message ?? "")[1];
  assert.deepEqual(choice, { label: "2. SQLite - no server needed", sends: "2" });
  await run(h.manager.answer(id, you.prompt, choice.sends));
  const confirm = await pendingAsk(h, id);
  assert.equal(confirm.kind, "confirmSummary");
  await run(h.manager.answer(id, confirm.prompt, ""));
  await ended(h, id);
  assert.equal(endCode(h, id), 0);
  assert.match(fs.readFileSync(path.join(repo, "plan-review", "conversation.md"), "utf8"), /\*\*User:\*\* 2\n/);
  assert.ok(eventsOf(h, id).some((e) => e._tag === "Answered" && e.text === "2"));
});

test("over the real adapters and the fake SDK, the run reports both agents' activity", async () => {
  const repo = tempRepo();
  const plan = path.join(repo, "plan-review", "plan.md");
  const writePlan = () => (async function* () {
    fs.writeFileSync(plan, "1. [ ] step\n");
    yield init("s-1");
    yield success(noQuestions);
  })();
  const report = { status: "finished", summary: "done", question: "", remaining_work: "" };
  const sdk = new FakeSdk([writePlan, messages(init("s-1"), success(report))], [turn(JSON.stringify({ issues: [] })), turn(JSON.stringify({ issues: [] }))]);
  const h = await harness(repo, [{}], (options) => ({ ...testWiring(repo, options).wiring, sdk, agents: Layer.mergeAll(claudePlannerLayer, codexReviewerLayer) }));
  const id = await started(h, repo);
  await ended(h, id);
  assert.equal(endCode(h, id), 0, JSON.stringify(eventsOf(h, id).filter((e) => e._tag === "Said").map((e) => (e as { text: string }).text)));
  const activity = eventsOf(h, id).flatMap((e) => (e._tag === "Notified" && e.event._tag === "AgentCallStarted" ? [`${e.event.agent}:${e.event.purpose}`] : []));
  assert.deepEqual(activity, ["claude:planning", "codex:review", "claude:execution", "codex:review"]);
});
