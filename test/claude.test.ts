import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudePlanner } from "../src/claude.ts";
import { State } from "../src/state.ts";
import { defaultConfig } from "../src/types.ts";
import { ScriptedUi, tempRepo } from "./helpers.ts";

// The hook is private; the test reaches it through a cast. No SDK call is made.
test("after a stop, the hook denies tools but permits the final structured output", async () => {
  const planner = new ClaudePlanner(new State(tempRepo()), new ScriptedUi([]), defaultConfig) as any;
  const call = (tool: string) => planner.denyAfterStop({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: {} }, undefined, { signal: new AbortController().signal });

  assert.deepEqual(await call("Write"), {});
  planner.stop = { question: "A or B?", input: "B" };
  assert.equal((await call("Write")).hookSpecificOutput.permissionDecision, "deny");
  assert.equal((await call("Bash")).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(await call("StructuredOutput"), {});
});
