// proto.ts -- prototype for the Claude Agent SDK, run inside the Claude Code container.
// Usage: node proto.ts /path/to/project
//
// It determines four things:
//   A. which credentials the SDK uses (printed in the [init] block);
//   B. whether a PreToolUse hook prevents file edits outside plan-review/ before they occur;
//   C. whether permission requests and AskUserQuestion calls arrive in the canUseTool callback;
//   D. (issue #6, 28 Sep 2026) whether an in-process report_step tool (createSdkMcpServer and tool) is called under
//      permissionMode "auto" with allowedTools without reaching canUseTool, and whether a PreToolUse hook that denies
//      it keeps its handler from running.

import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
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

// D. The in-process tool of an execution call. Two calls: the first may use it, the second denies it in a hook.
const reports: string[] = [];
const reporter = () =>
  createSdkMcpServer({
    name: "interloq",
    version: "1.0.0",
    tools: [
      tool("report_step", "Report the progress of a step: its id and 'started' or 'done'.", { id: z.string(), status: z.enum(["started", "done"]) }, async (args) => {
        reports.push(`${args.id}:${args.status}`);
        return { content: [{ type: "text", text: `Recorded: step ${args.id} is ${args.status}.` }] };
      }),
    ],
  });
const TOOL = "mcp__interloq__report_step";
const denyTool: HookCallback = async (input) => {
  const pre = input as PreToolUseHookInput;
  if (pre.tool_name !== TOOL) return {};
  return { hookSpecificOutput: { hookEventName: pre.hook_event_name, permissionDecision: "deny", permissionDecisionReason: "Execution is stopped." } };
};
for (const denied of [false, true]) {
  const before = reports.length;
  const reached: string[] = [];
  for await (const message of query({
    prompt: "This is a test of the program that runs you. Call the tool report_step with the id S1 and the status 'started', then with the id S1 and the status 'done'. Do not use any other tool. Then report what each call answered.",
    options: {
      cwd: projectDir,
      permissionMode: "auto",
      maxTurns: 10,
      mcpServers: { interloq: reporter() },
      allowedTools: [TOOL],
      hooks: denied ? { PreToolUse: [{ hooks: [denyTool] }] } : {},
      canUseTool: async (toolName, input) => {
        reached.push(toolName);
        return { behavior: "deny", message: "No other tool is permitted in this test." };
      },
    },
  })) {
    if (message.type === "assistant") for (const block of message.message.content) if (block.type === "text") console.log(`\n[claude] ${block.text}`);
  }
  const handled = reports.slice(before);
  console.log(`\n[D ${denied ? "denied by the hook" : "allowed"}] handler calls: ${JSON.stringify(handled)}; canUseTool reached for: ${JSON.stringify(reached)}`);
  console.log(`[D ${denied ? "denied" : "allowed"}] ${denied ? (handled.length === 0 ? "PASS: the hook kept the handler from running" : "FAIL: the handler ran despite the hook") : handled.length === 2 && !reached.includes(TOOL) ? "PASS: both reports reached the handler without canUseTool" : "FAIL: see above"}`);
}
