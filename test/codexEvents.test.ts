import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadEvent } from "@openai/codex-sdk";
import { toolEventOf } from "../src/codexEvents.ts";
import { command, fileChange, webSearch } from "./fakeSdk.ts";

/** The tool events of a stream, as the adapter folds it: an id already reported is not reported again. */
const fold = (events: readonly ThreadEvent[]) =>
  events.reduce<{ seen: ReadonlySet<string>; out: unknown[] }>(
    (acc, event) => {
      const tool = toolEventOf(acc.seen, event);
      return tool === null ? acc : { seen: new Set([...acc.seen, tool.id]), out: [...acc.out, tool.event] };
    },
    { seen: new Set(), out: [] },
  ).out;

test("a command is reported once, on item.started, though the SDK reports it started and completed", () => {
  assert.deepEqual(fold(command("c1", "npm test")), [{ _tag: "ToolUsed", agent: "codex", tool: "command", target: "npm test" }]);
});

test("a file change, reported only on completion, is reported with its paths", () => {
  assert.deepEqual(fold(fileChange("f1", "src/a.ts", "src/b.ts")), [{ _tag: "ToolUsed", agent: "codex", tool: "edit", target: "src/a.ts, src/b.ts" }]);
});

test("a web search is reported once with its query; messages, reasoning and turn events are not tool uses", () => {
  const other = [
    { type: "turn.started" },
    { type: "item.completed", item: { id: "m", type: "agent_message", text: "x" } },
    { type: "item.completed", item: { id: "r", type: "reasoning", text: "y" } },
  ] as ThreadEvent[];
  assert.deepEqual(fold([...other, ...webSearch("w", "q")]), [{ _tag: "ToolUsed", agent: "codex", tool: "search", target: "q" }]);
});
