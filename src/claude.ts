// Claude Code through the Claude Agent SDK.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, HookCallback, Options, PermissionResult, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import * as path from "node:path";
import type { Planner } from "./agents.ts";
import { execReportSchema } from "./schemas.ts";
import { Halt, type State } from "./state.ts";
import type { Config, ExecOutcome, ExecReport } from "./types.ts";
import type { Ui } from "./ui.ts";

const EDIT_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

type Question = { question: string; options: { label: string; description: string }[] };
type Stop = { question: string; input: string };
type CallResult = { structured: unknown; resultText: string; costUsd: number | null; error: string | null };

export class ClaudePlanner implements Planner {
  private readonly state: State;
  private readonly ui: Ui;
  private readonly config: Config;
  private readonly allowedDir: string;
  private session: string | null = null;
  private stop: Stop | null = null;

  constructor(state: State, ui: Ui, config: Config) {
    this.state = state;
    this.ui = ui;
    this.config = config;
    this.allowedDir = state.dir + path.sep;
  }

  sessionId(): string | null {
    return this.session;
  }

  async planning<T>(prompt: string, schema: object, progress = false): Promise<{ output: T; resultText: string; costUsd: number | null }> {
    const result = await this.call(prompt, progress ? "tools" : "none", {
      permissionMode: "default",
      outputFormat: { type: "json_schema", schema: schema as Record<string, unknown> },
      hooks: { PreToolUse: [{ matcher: EDIT_TOOLS.join("|"), hooks: [this.restrictEdits] }] },
      canUseTool: this.planningPermission,
    });
    if (result.error !== null) throw new Halt(`Claude Code planning call failed: ${result.error}`);
    if (result.structured === undefined || result.structured === null) throw new Halt("Claude Code returned no structured output");
    return { output: result.structured as T, resultText: result.resultText, costUsd: result.costUsd };
  }

  async executing(prompt: string): Promise<ExecOutcome> {
    this.stop = null;
    const result = await this.call(prompt, "text", {
      permissionMode: this.config.execPermissionMode,
      outputFormat: { type: "json_schema", schema: execReportSchema },
      hooks: { PreToolUse: [{ hooks: [this.denyAfterStop] }] },
      canUseTool: this.executionPermission,
    });
    const report = (result.structured ?? null) as ExecReport | null;
    const stop = this.stop as Stop | null;
    if (stop !== null) {
      return { status: "needs_input", summary: report?.summary ?? "", question: stop.question, remainingWork: report?.remaining_work ?? "", userInput: stop.input };
    }
    if (result.error !== null || report === null) {
      return { status: "aborted", summary: result.resultText, question: `The execution call ended without a status report: ${result.error ?? "no structured output"}`, remainingWork: "", userInput: null };
    }
    return { status: report.status, summary: report.summary, question: report.question, remainingWork: report.remaining_work, userInput: null };
  }

  private async call(prompt: string, show: "none" | "tools" | "text", options: Options): Promise<CallResult> {
    const full: Options = { ...options, cwd: this.state.project };
    if (this.session !== null) full.resume = this.session;
    if (this.config.claudeModel !== null) full.model = this.config.claudeModel;
    const out: CallResult = { structured: null, resultText: "", costUsd: null, error: "the call produced no result message" };
    try {
      for await (const message of query({ prompt, options: full })) {
        if (message.type === "system" && message.subtype === "init") {
          this.session = message.session_id;
        } else if (message.type === "assistant" && show !== "none") {
          for (const block of message.message.content) {
            if (show === "text" && block.type === "text" && block.text.trim() !== "") this.ui.say(`[claude] ${block.text.trim()}`);
            if (show === "tools" && block.type === "tool_use" && block.name !== "StructuredOutput") {
              const input = block.input as Record<string, unknown>;
              this.ui.say(`  [claude: ${block.name} ${String(input?.file_path ?? input?.pattern ?? input?.command ?? "")}]`);
            }
          }
        } else if (message.type === "result") {
          out.costUsd = message.total_cost_usd;
          this.state.recordUsage({ agent: "claude", session_id: this.session, num_turns: message.num_turns, total_cost_usd: message.total_cost_usd });
          if (message.subtype === "success") {
            out.structured = message.structured_output;
            out.resultText = message.result;
            out.error = null;
          } else {
            out.error = message.subtype;
          }
        }
      }
    } catch (e) {
      out.error = e instanceof Error ? e.message : String(e);
    }
    return out;
  }

  // Planning: deny every file edit whose target is outside plan-review/. A hook runs before the
  // permission evaluation, so the denial applies in every permission mode.
  private restrictEdits: HookCallback = async (input) => {
    const pre = input as PreToolUseHookInput;
    const toolInput = pre.tool_input as Record<string, unknown>;
    const target = path.resolve(this.state.project, String(toolInput?.file_path ?? toolInput?.notebook_path ?? ""));
    if (target.startsWith(this.allowedDir)) return {};
    return {
      hookSpecificOutput: {
        hookEventName: pre.hook_event_name,
        permissionDecision: "deny",
        permissionDecisionReason: "During a planning phase, only files under plan-review/ may be written.",
      },
    };
  };

  // Execution: after Claude Code has asked the user a question, deny every further tool call, so
  // that the turn ends and the plan is revised and reviewed before work continues.
  // The StructuredOutput tool carries the final status report, so it stays permitted.
  private denyAfterStop: HookCallback = async (input) => {
    if (this.stop === null) return {};
    const pre = input as PreToolUseHookInput;
    if (pre.tool_name === "StructuredOutput") return {};
    return {
      hookSpecificOutput: {
        hookEventName: pre.hook_event_name,
        permissionDecision: "deny",
        permissionDecisionReason: "Execution is stopped. Make no tool call other than the final structured output, and end your turn with status 'needs_input'.",
      },
    };
  };

  private planningPermission: CanUseTool = async (toolName, input): Promise<PermissionResult> => {
    if (toolName === "AskUserQuestion") {
      const questions = (input.questions ?? []) as Question[];
      const answers = await this.relayQuestions(questions);
      return { behavior: "allow", updatedInput: { questions, answers } };
    }
    if (EDIT_TOOLS.includes(toolName)) return { behavior: "allow", updatedInput: input };
    return { behavior: "deny", message: "During a planning phase, only reading and writing under plan-review/ are permitted." };
  };

  private executionPermission: CanUseTool = async (toolName, input): Promise<PermissionResult> => {
    if (toolName === "AskUserQuestion") {
      const questions = (input.questions ?? []) as Question[];
      this.ui.say("\nClaude Code has stopped execution with a question.");
      const answers = await this.relayQuestions(questions);
      this.stop = {
        question: questions.map((q) => q.question).join(" / "),
        input: Object.entries(answers).map(([q, a]) => `${q} -> ${a}`).join("; "),
      };
      return {
        behavior: "deny",
        message: "The user's answer is recorded in plan-review/user-decisions.md. Do not continue the implementation. Make no tool call other than the final structured output, and end your turn with status 'needs_input', a summary, and the remaining work. The plan will be revised and reviewed before work continues.",
      };
    }
    this.ui.say(`\nClaude Code requests permission: ${toolName} ${JSON.stringify(input)}`);
    const reply = await this.ui.ask("Allow? (y = yes, anything else = no, q = quit) > ");
    if (reply.toLowerCase() === "y") return { behavior: "allow", updatedInput: input };
    return { behavior: "deny", message: "The user denied this action." };
  };

  private async relayQuestions(questions: Question[]): Promise<Record<string, string>> {
    const answers: Record<string, string> = {};
    for (const q of questions) {
      this.ui.say(`\nQuestion from Claude Code: ${q.question}`);
      q.options.forEach((o, i) => this.ui.say(`  ${i + 1}. ${o.label} - ${o.description}`));
      let reply = "";
      while (reply === "") reply = await this.ui.ask("Number or free text (q = quit) > ");
      const answer = q.options[Number.parseInt(reply, 10) - 1]?.label ?? reply;
      answers[q.question] = answer;
      this.state.converse(`**Question from Claude Code:** ${q.question}\n\n**User answer:** ${answer}\n\n`);
    }
    return answers;
  }
}
