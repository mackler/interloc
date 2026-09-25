import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { Effect, Exit } from "effect";
import fc from "fast-check";
import { chooseOption, parseAskLine, parseExtraRounds, parseMessage } from "../src/input.ts";
import { terminalUi } from "../src/ui.ts";
import { ScriptedUi } from "./helpers.ts";

// Row 6 of the table in recommendation E of docs/functional-design-review.md.
const RUNS = { numRuns: 200, seed: 20260925 };

test("property: only an entire in-range integer chooses an option; every other reply is free text", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 9 }), fc.integer({ min: 1, max: 20 }), fc.constantFrom("", " ", "  "), (count, n, pad) => {
      const chosen = chooseOption(`${pad}${n}${pad}`, count);
      assert.equal(chosen, n <= count ? n - 1 : null);
    }),
    RUNS,
  );
  fc.assert(
    fc.property(fc.string().filter((s) => !/^\s*[1-9][0-9]*\s*$/.test(s)), fc.integer({ min: 1, max: 9 }), (text, count) => assert.equal(chooseOption(text, count), null)),
    RUNS,
  );
  fc.assert(fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), (n) => assert.equal(parseExtraRounds(` ${n} `), n)), RUNS);
  fc.assert(fc.property(fc.bigInt({ min: 2n ** 31n, max: 10n ** 25n }), (n) => assert.equal(parseExtraRounds(String(n)), null)), RUNS);
});

test("property: parseAskLine and parseMessage keep the text apart from the trimming and the two commands", () => {
  fc.assert(
    fc.property(fc.string(), (text) => {
      const line = parseAskLine(text);
      const trimmed = text.trim();
      assert.deepEqual(line, trimmed === "q" ? { kind: "quit" } : { kind: "answer", text: trimmed });
      const message = parseMessage(text);
      assert.deepEqual(message, trimmed === "/quit" ? { kind: "quit" } : { kind: "message", text: trimmed });
    }),
    RUNS,
  );
});

// One line, without a newline, as a terminal user would type it.
const arbLine = fc.stringMatching(/^[a-zA-Z0-9 \/"q]{0,12}$/);
type Outcome = { kind: "quit" } | { kind: "value"; value: string };
const outcome = async (effect: Effect.Effect<string, unknown>): Promise<Outcome> => {
  const exit = await Effect.runPromiseExit(effect);
  return Exit.isSuccess(exit) ? { kind: "value", value: exit.value } : { kind: "quit" };
};

test("property: the scripted Ui and the terminal Ui agree on every generated line, for ask and for askMessage", async () => {
  await fc.assert(
    fc.asyncProperty(arbLine, fc.boolean(), async (line, asMessage) => {
      const input = new PassThrough();
      const output = new PassThrough();
      output.resume();
      const live = Effect.scoped(terminalUi(input, output).pipe(Effect.flatMap((ui) => (asMessage ? ui.askMessage("> ") : ui.ask("> ")))));
      const livePromise = outcome(live);
      input.write(line + "\n");
      const scripted = new ScriptedUi([line]);
      const fromScripted = await outcome(asMessage ? scripted.askMessage("> ") : scripted.ask("> "));
      assert.deepEqual(await livePromise, fromScripted);
    }),
    { numRuns: 60, seed: 20260925 },
  );
});

test("property: a triple-quoted block of generated lines is returned as its trimmed content", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.stringMatching(/^[a-zA-Z0-9 ]{0,8}$/).filter((l) => l !== '"""'), { minLength: 1, maxLength: 4 }), async (lines) => {
      const input = new PassThrough();
      const output = new PassThrough();
      output.resume();
      const live = Effect.scoped(terminalUi(input, output).pipe(Effect.flatMap((ui) => ui.askMessage("> "))));
      const result = outcome(live);
      input.write(['"""', ...lines, '"""', ""].join("\n"));
      const expected = parseMessage(lines.join("\n"));
      assert.deepEqual(await result, expected.kind === "quit" ? { kind: "quit" } : { kind: "value", value: expected.text });
    }),
    { numRuns: 40, seed: 20260925 },
  );
});
