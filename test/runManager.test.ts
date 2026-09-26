import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Deferred, Effect, Fiber, Layer, Ref, Scope } from "effect";
import { claudePlannerLayer } from "../src/claude.ts";
import { codexReviewerLayer } from "../src/codex.ts";
import { platformLayer } from "../src/platform.ts";
import { program } from "../src/program.ts";
import type { RunEvent } from "../src/protocol.ts";
import { type Broadcast, type Listener, makePublisher, makeRunManager, type Refusal, type RunManager } from "../src/runManager.ts";
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
  const manager = await run(makeRunManager((ui) => ({ ...wiringOf(queue.shift() ?? {}), ui: Effect.succeed(ui) }), repo, "test").pipe(Effect.provide(platformLayer)));
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
  assert.equal(await run(h.manager.answer(h.manager.incarnation, id, asked.prompt, "PostgreSQL")), null);
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
  await run(h.manager.stop(h.manager.incarnation, id));
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
  assert.equal(await run(h.manager.stop(h.manager.incarnation, first)), null);
  await ended(h, first);
  assert.equal(endCode(h, first), 130);
  assert.ok(eventsOf(h, first).some((e) => e._tag === "Said" && /INTERRUPTED by the user\. State is preserved in/.test(e.text)));
  assert.match(fs.readFileSync(path.join(repo, "plan-review", "conversation.md"), "utf8"), /\*\*Interrupted by the user\.\*\*/);
  assert.match(((await run(h.manager.answer(h.manager.incarnation, first, asked.prompt, "late"))) as Refusal).refused, /that run has ended/);
  assert.match(((await run(h.manager.stop(h.manager.incarnation, first))) as Refusal).refused, /that run has ended/);

  const second = await started(h, repo);
  assert.equal(second, first + 1);
  assert.deepEqual(h.received.find((b) => b.run === second), { run: second, seq: 0, event: eventsOf(h, second)[0] });
  assert.match(((await run(h.manager.answer(h.manager.incarnation, first, asked.prompt, "late"))) as Refusal).refused, /that run has ended/);
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
  await run(h.manager.stop(h.manager.incarnation, second));
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
  await run(h.manager.answer(h.manager.incarnation, id, opening.prompt, "let us talk"));
  const you = await pendingAsk(h, id);
  assert.equal(you.kind, "interviewMessage");
  assert.equal(you.extra, "numberedAnswers");
  const turnEvent = eventsOf(h, id).flatMap((e) => (e._tag === "Notified" && e.event._tag === "InterviewTurn" ? [e.event] : [])).at(-1);
  const choice = numberedChoices(turnEvent?.message ?? "")[1];
  assert.deepEqual(choice, { label: "2. SQLite - no server needed", sends: "2" });
  await run(h.manager.answer(h.manager.incarnation, id, you.prompt, choice.sends));
  const confirm = await pendingAsk(h, id);
  assert.equal(confirm.kind, "confirmSummary");
  await run(h.manager.answer(h.manager.incarnation, id, confirm.prompt, ""));
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

// Finding 4 of docs/gui-review.md: the project is the worktree root; a subdirectory or a bare repository is refused
// before anything is archived or initialised.
test("a subdirectory of a repository and a bare repository are refused; the root and a link to it are accepted", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [converging]);
  fs.mkdirSync(path.join(repo, "sub"));
  const sub = (await run(h.manager.start(path.join(repo, "sub"), "t"))) as Refusal;
  assert.equal(typeof sub, "object", "the subdirectory was started");
  assert.match(sub.refused, /is inside the git repository/);
  assert.ok(sub.refused.includes(fs.realpathSync(repo)), "the refusal names the repository root");
  assert.match(sub.refused, /choose its top-level directory/);
  assert.ok(!fs.existsSync(path.join(repo, "plan-review")) && !fs.existsSync(path.join(repo, "sub", "plan-review")), "records were initialised");

  const bare = tempDir("pr-bare-");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  const refusedBare = (await run(h.manager.start(bare, "t"))) as Refusal;
  assert.equal(typeof refusedBare, "object", "the bare repository was started");
  assert.match(refusedBare.refused, /is a bare repository/);

  const link = path.join(tempDir("pr-link-"), "project");
  fs.symlinkSync(repo, link);
  const id = await started(h, link);
  await ended(h, id);
  assert.equal(endCode(h, id), 0);
});

// Finding 11 of docs/gui-review.md: every ownership transfer is cancellation-safe.
test("publication: two concurrent publishers deliver every event to every listener in the order of its seq", async () => {
  const state = await run(Ref.make(0));
  const seen: number[][] = [[], []];
  const listeners = await run(Ref.make<ReadonlySet<Listener<number>>>(new Set(seen.map((into) => (n: number) => Effect.forEach(Array.from({ length: n % 2 === 0 ? 3 : 0 }), () => Effect.yieldNow).pipe(Effect.andThen(Effect.sync(() => void into.push(n))))))));
  // An even event is slower to deliver, so an unserialized publisher lets the next odd one overtake it.
  const publish = await run(makePublisher(state, listeners));
  const next = (s: number): readonly [number, number] => [s, s + 1];
  await run(Effect.all([Effect.forEach(Array.from({ length: 50 }), () => publish(next)), Effect.forEach(Array.from({ length: 50 }), () => publish(next))], { concurrency: 2 }));
  for (const into of seen) assert.deepEqual(into, Array.from({ length: 100 }, (_, i) => i), "an event offered out of seq order");
});

test("publication: a publisher interrupted while a listener is delivering still offers the recorded event to every listener", async () => {
  const state = await run(Ref.make(0));
  const entered = await run(Deferred.make<void>());
  const release = await run(Deferred.make<void>());
  const second: number[] = [];
  const blocking: Listener<number> = () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
  const listeners = await run(Ref.make<ReadonlySet<Listener<number>>>(new Set([blocking, (n: number) => Effect.sync(() => void second.push(n))])));
  const publish = await run(makePublisher(state, listeners));
  const publisher = Effect.runFork(publish((s) => [s, s + 1]));
  await run(Deferred.await(entered));
  const interruption = Effect.runFork(Fiber.interrupt(publisher));
  await run(Deferred.succeed(release, undefined));
  await run(Fiber.await(interruption));
  assert.equal(await run(Ref.get(state)), 1);
  assert.deepEqual(second, [0], "the event was recorded but not offered");
});

test("start interrupted while Started is being delivered leaves a run that can be stopped, and a new start is accepted after it", async () => {
  const repo = tempRepo();
  const h = await harness(repo, [{ steps: [{ hang: true }] }, converging]);
  const entered = await run(Deferred.make<void>());
  const release = await run(Deferred.make<void>());
  await run(
    h.manager
      .subscribe((b) => (b.event._tag === "Started" && b.run === 1 ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void))
      .pipe(Scope.provide(h.scope)),
  );
  const starting = Effect.runFork(h.manager.start(repo, "t"));
  await run(Deferred.await(entered));
  const interruption = Effect.runFork(Fiber.interrupt(starting));
  await run(Deferred.succeed(release, undefined));
  await run(Fiber.await(interruption));
  assert.equal(await run(h.manager.current), 1, "the run was not reserved");
  assert.equal(await run(h.manager.stop(h.manager.incarnation, 1)), null, "the run cannot be stopped");
  await ended(h, 1);
  const id = await started(h, repo);
  await ended(h, id);
  assert.equal(endCode(h, id), 0);
});

// Finding 12 of docs/gui-review.md: an action of another incarnation is refused even when its numbers match.
test("a stop and an answer with the current run's numbers but another incarnation are refused, and the run continues", async () => {
  const repo = tempRepo();
  const withQuestion: TestOptions = { steps: [{ output: { questions_for_user: ["Which?"] }, plan: "v1" }, { output: noQuestions }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] };
  const h = await harness(repo, [withQuestion]);
  const id = await started(h, repo);
  const asked = await pendingAsk(h, id);
  const stale = (await run(h.manager.stop("an earlier start", id))) as Refusal;
  assert.match(stale.refused, /earlier start of the server/);
  const staleAnswer = (await run(h.manager.answer("an earlier start", id, asked.prompt, "x"))) as Refusal;
  assert.match(staleAnswer.refused, /earlier start of the server/);
  assert.equal(await run(h.manager.answer(h.manager.incarnation, id, asked.prompt, "")), null);
  await ended(h, id);
  assert.equal(endCode(h, id), 0);
});
