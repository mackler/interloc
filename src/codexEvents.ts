// Pure decoding of the events of a streamed Codex turn (plan step 1.8): the tool uses for the activity line.

import type { ThreadEvent } from "@openai/codex-sdk";
import type { UiEvent } from "./uiEvents.ts";

export type ToolUse = Readonly<{ id: string; event: Extract<UiEvent, { _tag: "ToolUsed" }> }>;

/**
 * The tool use an event reports, or null. A command and a web search are reported on item.started, a file
 * change on item.completed (the SDK emits it only then); an item id in `seen` is not reported again.
 */
export const toolEventOf = (seen: ReadonlySet<string>, event: ThreadEvent): ToolUse | null => {
  if (event.type !== "item.started" && event.type !== "item.completed") return null;
  const item = event.item;
  if (seen.has(item.id)) return null;
  const used = (tool: string, target: string): ToolUse => ({ id: item.id, event: { _tag: "ToolUsed", agent: "codex", tool, target } });
  switch (item.type) {
    case "command_execution":
      return event.type === "item.started" ? used("command", item.command) : null;
    case "web_search":
      return event.type === "item.started" ? used("search", item.query) : null;
    case "file_change":
      return event.type === "item.completed" ? used("edit", item.changes.map((c) => c.path).join(", ")) : null;
    default:
      return null;
  }
};

/** What a streamed turn produced: the text of its last agent message and its usage, or the reason it failed. */
export type TurnOutcome = Readonly<{ kind: "ok"; finalResponse: string; usage: Readonly<{ input_tokens: number; output_tokens: number }> | null }> | Readonly<{ kind: "failed"; message: string }>;

/** The reduction of a turn's events: turn.failed or an error event fails it, and a turn without an agent message has no reply. */
export const reduceTurn = (events: readonly ThreadEvent[]): TurnOutcome => {
  const failure = events.find((e) => e.type === "turn.failed" || e.type === "error");
  if (failure !== undefined) return { kind: "failed", message: failure.type === "turn.failed" ? failure.error.message : failure.type === "error" ? failure.message : "" };
  const messages = events.flatMap((e) => (e.type === "item.completed" && e.item.type === "agent_message" ? [e.item.text] : []));
  const last = messages[messages.length - 1];
  if (last === undefined) return { kind: "failed", message: "no reply: the turn ended without an agent message" };
  const completed = events.find((e) => e.type === "turn.completed");
  const usage = completed?.type === "turn.completed" ? { input_tokens: completed.usage.input_tokens ?? 0, output_tokens: completed.usage.output_tokens ?? 0 } : null;
  return { kind: "ok", finalResponse: last, usage };
};
