import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { RunError } from "../src/errors.ts";
import { TerminalUi } from "../src/ui.ts";

const streams = (): { input: PassThrough; output: PassThrough; written: () => string } => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk: Buffer | string) => void (written += String(chunk)));
  return { input, output, written: () => written };
};

test("ask reads its answer from the given input stream and writes the prompt to the given output stream", async () => {
  const { input, output, written } = streams();
  const ui = new TerminalUi(input, output);
  const answer = ui.ask("Decision > ");
  input.write("  keep it  \n");
  assert.equal(await answer, "keep it");
  assert.match(written(), /Decision > /);
});

test("askMessage reads from the given input stream", async () => {
  const { input, output } = streams();
  const ui = new TerminalUi(input, output);
  const message = ui.askMessage("You > ");
  input.write("one line\n");
  assert.equal(await message, "one line");
});

const stoppedByUser = (e: unknown): boolean => (e as RunError)._tag === "UserStopped";

test("ask q fails with UserStopped", async () => {
  const { input, output } = streams();
  const answer = new TerminalUi(input, output).ask("Decision > ");
  input.write("q\n");
  await assert.rejects(answer, stoppedByUser);
});

test("askMessage /quit fails with UserStopped", async () => {
  const { input, output } = streams();
  const message = new TerminalUi(input, output).askMessage("You > ");
  input.write("/quit\n");
  await assert.rejects(message, stoppedByUser);
});
