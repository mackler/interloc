// proto.ts -- prototype for the Claude Agent SDK, run inside the Claude Code container.
// Usage: node proto.ts /path/to/project
//
// It determines three things:
//   A. which credentials the SDK uses (printed in the [init] block);
//   B. whether a PreToolUse hook prevents file edits outside plan-review/ before they occur;
//   C. whether permission requests and AskUserQuestion calls arrive in the canUseTool callback.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import * as readline from "node:readline/promises";
import * as path from "node:path";

const projectArg = process.argv[2];
if (!projectArg) {
  console.error("usage: node proto.ts /path/to/project");
  process.exit(2);
}
const projectDir = path.resolve(projectArg);
const allowedDir = path.join(projectDir, "plan-review") + path.sep;

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

// B. Deny every file edit whose target is outside plan-review/. The hook runs before the
// permission evaluation, so the denial applies in every permission mode.
const restrictEdits: HookCallback = async (input) => {
  const pre = input as PreToolUseHookInput;
  const toolInput = pre.tool_input as Record<string, unknown>;
  const target = String(toolInput?.file_path ?? toolInput?.notebook_path ?? "");
  const resolved = path.resolve(projectDir, target);
  if (resolved.startsWith(allowedDir)) {
    return {};
  }
  console.log(`[hook] denied ${pre.tool_name} on ${resolved}`);
  return {
    hookSpecificOutput: {
      hookEventName: pre.hook_event_name,
      permissionDecision: "deny",
      permissionDecisionReason: "During planning, only files under plan-review/ may be written.",
    },
  };
};

// C. Every request that no rule or mode has approved arrives here, as does AskUserQuestion.
type Question = { question: string; header: string; options: { label: string; description: string }[] };

const prompt = [
  "This is a test of the program that runs you. Do these four steps in order and then report what happened at each step.",
  "1. Use the AskUserQuestion tool to ask me whether the test file is to be named alpha.md or beta.md.",
  "2. Create that file in the directory plan-review/ with one line of text.",
  "3. Try to create the file proto-test-outside.txt in the project root. If this is denied, do not try another method.",
  "4. Run the shell command: touch /tmp/proto-test",
].join("\n");

for await (const message of query({
  prompt,
  options: {
    cwd: projectDir,
    permissionMode: "default",
    maxTurns: 20,
    hooks: {
      PreToolUse: [{ matcher: "Write|Edit|MultiEdit|NotebookEdit", hooks: [restrictEdits] }],
    },
    canUseTool: async (toolName, input) => {
      if (toolName === "AskUserQuestion") {
        const questions = (input.questions ?? []) as Question[];
        const answers: Record<string, string> = {};
        for (const q of questions) {
          console.log(`\n[question] ${q.question}`);
          q.options.forEach((o, i) => console.log(`  ${i + 1}. ${o.label} - ${o.description}`));
          const reply = await ask("Number or free text > ");
          const index = Number.parseInt(reply, 10) - 1;
          answers[q.question] = q.options[index]?.label ?? reply;
        }
        return { behavior: "allow", updatedInput: { questions, answers } };
      }
      console.log(`\n[permission request] ${toolName}: ${JSON.stringify(input)}`);
      const reply = await ask("Allow? (y/n) > ");
      if (reply.toLowerCase() === "y") {
        return { behavior: "allow", updatedInput: input };
      }
      return { behavior: "deny", message: "The user denied this action." };
    },
  },
})) {
  if (message.type === "system" && message.subtype === "init") {
    // A. Print every scalar field of the init message; print only the length of each list.
    const summary: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(message as Record<string, unknown>)) {
      summary[key] = Array.isArray(value) ? `(list of ${value.length})` : value;
    }
    console.log("[init]", JSON.stringify(summary, null, 2));
  } else if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "text") console.log(`\n[claude] ${block.text}`);
      if (block.type === "tool_use") console.log(`[tool call] ${block.name}`);
    }
  } else if (message.type === "result") {
    const { type, subtype, session_id, num_turns, total_cost_usd } = message;
    console.log("\n[result]", JSON.stringify({ type, subtype, session_id, num_turns, total_cost_usd }, null, 2));
  }
}
