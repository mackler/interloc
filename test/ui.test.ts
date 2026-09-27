import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Effect, Fiber } from "effect";
import type { RunError } from "../src/errors.ts";
import type { UiShape } from "../src/services.ts";
import * as prompts from "../src/prompts.ts";
import { terminalUi } from "../src/ui.ts";

type Streams = { input: PassThrough; output: PassThrough; written: () => string };
const streams = (): Streams => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk: Buffer | string) => void (written += String(chunk)));
  return { input, output, written: () => written };
};

/** Runs `use` with a terminal Ui on the streams, inside one scope. */
const withUi = <A, E>(io: Streams, use: (ui: UiShape) => Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.scoped(terminalUi(io.input, io.output).pipe(Effect.flatMap(use))));

/** A promise, or "timeout" after the given time, so that a hanging read fails instead of blocking the suite. */
const orTimeout = <A>(promise: Promise<A>, ms = 30_000): Promise<A | "timeout"> =>
  Promise.race([promise, sleep(ms, "timeout" as const, { ref: false })]);

/** Waits until the condition holds, polling; fails after 30 s, so that a loaded machine only slows a passing test. */
const eventually = async (what: string, condition: () => boolean, ms = 30_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
};

const stoppedByUser = (e: unknown): boolean => (e as RunError)._tag === "UserStopped";

test("ask reads its answer from the given input stream and writes the prompt to the given output stream", async () => {
  const io = streams();
  const answer = withUi(io, (ui) => ui.ask("Decision > "));
  io.input.write("keep it\n");
  assert.equal(await answer, "keep it");
  assert.match(io.written(), /Decision > /);
});

test("ask trims the answer", async () => {
  const io = streams();
  const answer = withUi(io, (ui) => ui.ask("Decision > "));
  io.input.write("  keep it  \n");
  assert.equal(await answer, "keep it");
});

test("askMessage reads from the given input stream", async () => {
  const io = streams();
  const message = withUi(io, (ui) => ui.askMessage("You > "));
  io.input.write("one line\n");
  assert.equal(await message, "one line");
});

test("askMessage reads a triple-quoted block of several lines", async () => {
  const io = streams();
  const message = withUi(io, (ui) => ui.askMessage("You > "));
  io.input.write('"""\nline 1\n\nline 3\n"""\n');
  assert.equal(await message, "line 1\n\nline 3");
});

test("pasted lines are not lost between two askMessage calls", async () => {
  const io = streams();
  io.input.write("one\ntwo\n");
  const both = withUi(io, (ui) => Effect.all([ui.askMessage("You > "), ui.askMessage("You > ")]));
  assert.deepEqual(await orTimeout(both), ["one", "two"]);
});

// Finding 20: the dialogue is serialized; a second concurrent ask waits for the first.
test("two concurrent asks are answered in order, and the second prompt appears only after the first answer", async () => {
  const io = streams();
  const answers = withUi(io, (ui) => Effect.all([ui.ask("First > "), ui.ask("Second > ")], { concurrency: "unbounded" }));
  await eventually("the first prompt", () => /First > /.test(io.written()));
  await sleep(20);
  assert.doesNotMatch(io.written(), /Second > /, "the second prompt was shown while the first ask was pending");
  io.input.write("one\n");
  await eventually("the second prompt", () => /Second > /.test(io.written()));
  io.input.write("two\n");
  assert.deepEqual(await orTimeout(answers), ["one", "two"]);
});

test("say writes the text and a newline", async () => {
  const io = streams();
  await withUi(io, (ui) => ui.say("hello"));
  assert.equal(io.written(), "hello\n");
});

test("ask q fails with UserStopped", async () => {
  const io = streams();
  const answer = withUi(io, (ui) => ui.ask("Decision > "));
  io.input.write("q\n");
  await assert.rejects(answer, stoppedByUser);
});

test("askMessage /quit fails with UserStopped", async () => {
  const io = streams();
  const message = withUi(io, (ui) => ui.askMessage("You > "));
  io.input.write("/quit\n");
  await assert.rejects(message, stoppedByUser);
});

test("interrupting ask closes the readline interface", async () => {
  const io = streams();
  const fiber = Effect.runFork(Effect.scoped(terminalUi(io.input, io.output).pipe(Effect.flatMap((ui) => ui.ask("Decision > ")))));
  while (!io.written().includes("Decision > ")) await sleep(5);
  assert.ok(io.input.listenerCount("data") > 0, "the interface is not reading the input while ask waits");
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.equal(io.input.listenerCount("data"), 0, "the interface still reads the input after the interruption");
  assert.equal(io.input.listenerCount("end"), 0);
});

test("Ctrl+C in a terminal reaches the process as SIGINT while the interface is open", async () => {
  // readline handles Ctrl+C itself in terminal mode, so the resource must pass it on.
  const io = streams();
  (io.output as PassThrough & { isTTY?: boolean }).isTTY = true;
  const signals: string[] = [];
  const fiber = Effect.runFork(Effect.scoped(terminalUi(io.input, io.output, () => signals.push("SIGINT")).pipe(Effect.flatMap((ui) => ui.ask("Decision > ")))));
  while (!io.written().includes("Decision > ")) await sleep(5);
  io.input.write("\x03");
  await eventually("the SIGINT", () => signals.length > 0);
  assert.deepEqual(signals, ["SIGINT"]);
  await Effect.runPromise(Fiber.interrupt(fiber));
});

test("notify writes nothing to the terminal", async () => {
  const io = streams();
  await withUi(io, (ui) => ui.notify({ _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } }));
  assert.equal(io.written(), "");
});

// Finding 8 of docs/gui-review.md: the terminal renders the interview's opening help, with its """ convention.
test("notify renders the interview's opening help in the terminal, with the multiline convention", async () => {
  const io = streams();
  await withUi(io, (ui) => ui.notify({ _tag: "InterviewOpened", heading: "Clarification" }));
  assert.ok(io.written().includes(prompts.interviewHelp("Clarification", "terminal")));
  assert.match(io.written(), /""" on its own line/);
});

// Issue #5 (Q2): the terminal keeps the "[claude] " prefix, its only attribution of Claude Code's prose.
test("notify renders Claude Code's prose in the terminal with the [claude] prefix", async () => {
  const io = streams();
  await withUi(io, (ui) => ui.notify({ _tag: "ClaudeSaid", text: "done" }));
  assert.equal(io.written(), "[claude] done\n");
});
