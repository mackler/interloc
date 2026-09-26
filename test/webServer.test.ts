import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Effect } from "effect";
import { HttpServer } from "effect/unstable/http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { platformLayer } from "../src/platform.ts";
import type { ClientMessage, RunEvent, ServerMessage } from "../src/protocol.ts";
import { makeRunManager, type RunManager } from "../src/runManager.ts";
import { makeWebServer } from "../src/webServer.ts";
import { finished, type TestOptions, tempDir, tempRepo, testWiring } from "./helpers.ts";

// Plan step 3.4: the server over NodeHttpServer.layerTest, with Node's WebSocket as the scripted client.
const noQuestions = { questions_for_user: [] };
const converging: TestOptions = { steps: [{ output: noQuestions, plan: "v1" }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] };
const withQuestion: TestOptions = { steps: [{ output: { questions_for_user: ["Which?"] }, plan: "v1" }, { output: noQuestions }], reviews: [{ issues: [] }, { issues: [] }], execs: [finished] };

const managerOf = async (repo: string, scripts: TestOptions[]): Promise<RunManager> => {
  const queue = [...scripts];
  return Effect.runPromise(makeRunManager((ui) => ({ ...testWiring(repo, queue.shift() ?? {}).wiring, ui: Effect.succeed(ui) }), repo).pipe(Effect.provide(platformLayer)));
};
const dist = (): string => {
  const d = tempDir("pr-dist-");
  fs.writeFileSync(path.join(d, "index.html"), "<!doctype html><title>plan-review</title>");
  fs.mkdirSync(path.join(d, "assets"));
  fs.writeFileSync(path.join(d, "assets", "app.js"), "console.log(1)");
  return d;
};
/** Serves the handler on an ephemeral port for the duration of `body`. */
const serve = (manager: RunManager, distDir: string, body: (port: number) => Promise<void>): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* HttpServer.serveEffect(makeWebServer(manager, distDir));
        const address = (yield* HttpServer.HttpServer).address;
        const port = address._tag === "UnixPathAddress" ? 0 : address.port;
        yield* Effect.promise(() => body(port));
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

type Client = { messages: ServerMessage[]; send: (m: ClientMessage) => void; close: () => void };
const connect = (port: number): Promise<Client> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: ServerMessage[] = [];
    ws.onmessage = (e) => void messages.push(JSON.parse(String(e.data)));
    ws.onerror = () => reject(new Error("the WebSocket failed"));
    ws.onopen = () => resolve({ messages, send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close() });
  });
const until = async (what: string, condition: () => boolean, ms = 5000): Promise<void> => {
  for (let waited = 0; waited < ms; waited += 5) {
    if (condition()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
};
/** The events a client has of each run, from the replay and the live messages, as (seq, event) in arrival order. */
const perRun = (c: Client): Map<number, { seq: number; event: RunEvent }[]> => {
  const runs = new Map<number, { seq: number; event: RunEvent }[]>();
  const add = (run: number, seq: number, event: RunEvent) => runs.set(run, [...(runs.get(run) ?? []), { seq, event }]);
  for (const m of c.messages) {
    if (m.type === "replay") for (const r of m.runs) r.events.forEach((event, seq) => add(r.id, seq, event));
    if (m.type === "event") add(m.run, m.seq, m.event);
  }
  return runs;
};
/** Every run's events are exactly 0, 1, 2, … : no gap and no duplicate. */
const contiguous = (c: Client): void => {
  for (const [run, events] of perRun(c)) assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i), `run ${run} has a gap or a duplicate`);
};
const hasEnded = (c: Client, run: number) => (perRun(c).get(run) ?? []).some((e) => e.event._tag === "Ended");
const pending = (c: Client, run: number) => {
  const events = perRun(c).get(run) ?? [];
  const last = [...events].reverse().find((e) => e.event._tag === "Asked" || e.event._tag === "Answered");
  return last?.event._tag === "Asked" ? last.event : null;
};
const refusals = (c: Client) => c.messages.flatMap((m) => (m.type === "refused" ? [m.reason] : []));

test("on connect: hello and an empty replay", async () => {
  const repo = tempRepo();
  await serve(await managerOf(repo, []), dist(), async (port) => {
    const c = await connect(port);
    await until("two messages", () => c.messages.length >= 2);
    assert.deepEqual(c.messages.slice(0, 2), [{ type: "hello", cwd: repo, current: null }, { type: "replay", runs: [] }]);
    c.close();
  });
});

test("the page and its assets are served; any other path, and a path out of the build, is 404", async () => {
  const repo = tempRepo();
  await serve(await managerOf(repo, []), dist(), async (port) => {
    const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`);
    const page = await get("/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /plan-review/);
    assert.equal((await get("/assets/app.js")).status, 200);
    assert.equal((await get("/nope")).status, 404);
    assert.equal((await get("/assets/..%2F..%2Fetc%2Fpasswd")).status, 404);
  });
});

test("a started run's events reach two clients in the same order with increasing seq", async () => {
  const repo = tempRepo();
  await serve(await managerOf(repo, [converging]), dist(), async (port) => {
    const a = await connect(port);
    const b = await connect(port);
    await until("the replays", () => a.messages.length >= 2 && b.messages.length >= 2);
    a.send({ type: "start", project: repo, task: "task" });
    await until("the end of run 1", () => hasEnded(a, 1) && hasEnded(b, 1));
    const events = (c: Client) => c.messages.filter((m) => m.type === "event");
    assert.deepEqual(events(a), events(b));
    contiguous(a);
    assert.equal(perRun(a).get(1)?.[0].event._tag, "Started");
    a.close();
    b.close();
  });
});

test("a client that connects mid-run gets the replay with the pending prompt and can answer; a second answer is ignored", async () => {
  const repo = tempRepo();
  await serve(await managerOf(repo, [withQuestion]), dist(), async (port) => {
    const a = await connect(port);
    a.send({ type: "start", project: repo, task: "task" });
    await until("the prompt", () => pending(a, 1) !== null);
    const late = await connect(port);
    await until("the replay", () => late.messages.some((m) => m.type === "replay"));
    const asked = pending(late, 1);
    assert.ok(asked !== null && asked._tag === "Asked" && asked.kind === "decision");
    assert.equal((late.messages[0] as { current: number | null }).current, 1);
    late.send({ type: "answer", run: 1, prompt: asked.prompt, text: "PostgreSQL" });
    a.send({ type: "answer", run: 1, prompt: asked.prompt, text: "SQLite" });
    await until("the end", () => hasEnded(a, 1));
    await until("the refusal of the second answer", () => refusals(a).length > 0);
    assert.match(refusals(a)[0], /already been answered/);
    assert.match(fs.readFileSync(path.join(repo, "plan-review", "user-decisions.md"), "utf8"), /Decision: PostgreSQL/);
    contiguous(a);
    contiguous(late);
    a.close();
    late.close();
  });
});

test("an event appended between the subscription and the snapshot reaches the client exactly once", async () => {
  const repo = tempRepo();
  const real = await managerOf(repo, [withQuestion]);
  let hook: Effect.Effect<void> = Effect.void;
  // The handler subscribes first, then reads the replay: the hook runs in between.
  const manager: RunManager = { ...real, replay: Effect.suspend(() => hook).pipe(Effect.andThen(real.replay)) };
  await serve(manager, dist(), async (port) => {
    const a = await connect(port);
    a.send({ type: "start", project: repo, task: "task" });
    await until("the prompt", () => pending(a, 1) !== null);
    const asked = pending(a, 1)!;
    hook = real.answer(1, (asked as { prompt: number }).prompt, "PostgreSQL").pipe(Effect.andThen(Effect.sleep("20 millis")), Effect.asVoid);
    const b = await connect(port);
    hook = Effect.void;
    await until("the end on b", () => hasEnded(b, 1));
    contiguous(b);
    assert.equal((perRun(b).get(1) ?? []).filter((e) => e.event._tag === "Answered").length, 1);
    a.close();
    b.close();
  });
});

test("a run that ends between the subscription and the snapshot is received once, in the replay", async () => {
  const repo = tempRepo();
  const real = await managerOf(repo, [withQuestion]);
  let hook: Effect.Effect<void> = Effect.void;
  const manager: RunManager = { ...real, replay: Effect.suspend(() => hook).pipe(Effect.andThen(real.replay)) };
  await serve(manager, dist(), async (port) => {
    const a = await connect(port);
    a.send({ type: "start", project: repo, task: "task" });
    await until("the prompt", () => pending(a, 1) !== null);
    hook = real.stop(1).pipe(Effect.asVoid);
    const b = await connect(port);
    hook = Effect.void;
    await until("b's replay", () => b.messages.some((m) => m.type === "replay"));
    await sleep(50);
    const replay = b.messages.find((m) => m.type === "replay");
    assert.ok(replay?.type === "replay" && replay.runs.length === 1 && replay.runs[0].events.at(-1)?._tag === "Ended");
    assert.equal(b.messages.filter((m) => m.type === "event").length, 0, "buffered events of the ended run were sent again");
    contiguous(b);
    a.close();
    b.close();
  });
});

test("a connection kept open across two runs receives run 2 from its Started, with no gap in either run", async () => {
  const repo = tempRepo();
  await serve(await managerOf(repo, [withQuestion, converging]), dist(), async (port) => {
    const a = await connect(port);
    a.send({ type: "start", project: repo, task: "first" });
    await until("the prompt", () => pending(a, 1) !== null);
    // A connection made well into run 1.
    const late = await connect(port);
    await until("the replay", () => late.messages.some((m) => m.type === "replay"));
    const replay = late.messages.find((m) => m.type === "replay");
    const atConnect = replay?.type === "replay" ? (replay.runs[0]?.events.length ?? 0) : 0;
    assert.ok(atConnect >= 5, `run 1 had only ${atConnect} events at the connection`);
    a.send({ type: "stop", run: 1 });
    await until("the end of run 1", () => hasEnded(late, 1));
    assert.equal((perRun(late).get(1) ?? []).find((e) => e.event._tag === "Ended")?.event._tag, "Ended");
    a.send({ type: "start", project: repo, task: "second" });
    await until("the end of run 2", () => hasEnded(late, 2) && hasEnded(a, 2));
    for (const c of [a, late]) {
      contiguous(c);
      assert.equal(perRun(c).get(2)?.[0].seq, 0);
      assert.equal(perRun(c).get(2)?.[0].event._tag, "Started");
    }
    const ended1 = (perRun(a).get(1) ?? []).find((e) => e.event._tag === "Ended")?.event;
    assert.deepEqual(ended1, { _tag: "Ended", code: 130 });
    a.close();
    late.close();
  });
});

test("an answer or a stop naming an ended run is refused; a frame that is not a message is refused", async () => {
  const repo = tempRepo();
  await serve(await managerOf(repo, [converging]), dist(), async (port) => {
    const a = await connect(port);
    a.send({ type: "start", project: repo, task: "task" });
    await until("the end", () => hasEnded(a, 1));
    a.send({ type: "answer", run: 1, prompt: 1, text: "late" });
    a.send({ type: "stop", run: 1 });
    await until("two refusals", () => refusals(a).length >= 2);
    assert.deepEqual(refusals(a).slice(0, 2).map((r) => /that run has ended/.test(r)), [true, true]);
    (a as unknown as { send: (m: unknown) => void }).send("not a message" as never);
    await until("the frame's refusal", () => refusals(a).length >= 3);
    assert.match(refusals(a)[2], /not a message|not JSON|Expected/);
    a.close();
  });
});

test("start with a bad path is refused with the reason; list gives the subdirectories", async () => {
  const repo = tempRepo();
  fs.mkdirSync(path.join(repo, "src"));
  fs.mkdirSync(path.join(repo, "docs"));
  await serve(await managerOf(repo, []), dist(), async (port) => {
    const a = await connect(port);
    a.send({ type: "start", project: path.join(repo, "missing"), task: "t" });
    await until("the refusal", () => refusals(a).length > 0);
    assert.match(refusals(a)[0], /does not exist/);
    a.send({ type: "list", path: repo });
    await until("the listing", () => a.messages.some((m) => m.type === "listing"));
    const listing = a.messages.find((m) => m.type === "listing");
    assert.deepEqual(listing, { type: "listing", path: repo, parent: path.dirname(repo), dirs: [".git", "docs", "src"], error: null });
    a.send({ type: "list", path: path.join(repo, "missing") });
    await until("the second listing", () => a.messages.filter((m) => m.type === "listing").length >= 2);
    assert.notEqual((a.messages.filter((m) => m.type === "listing")[1] as { error: string | null }).error, null);
    a.close();
  });
});
