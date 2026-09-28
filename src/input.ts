// Pure interpretation of what the user types. No I/O; used by the terminal Ui and the agent adapters.

import { UNCHANGED_ANSWERS } from "./prompts.ts";

/**
 * The option a reply chooses, as a zero-based index, or null when the reply is not a whole number in
 * 1..count. Only the entire (trimmed) reply counts: "1 please explain" and "1.5" are free text
 * (finding 18 of docs/functional-design-review.md).
 */
/** What a line typed at a one-line prompt means: the run ends on "q", anything else is the (trimmed) answer. */
export const parseAskLine = (line: string): { kind: "quit" } | { kind: "answer"; text: string } => {
  const text = line.trim();
  return text === "q" ? { kind: "quit" } : { kind: "answer", text };
};

/** What a message of the interview means: the run ends on "/quit", anything else is the (trimmed) message. */
export const parseMessage = (message: string): { kind: "quit" } | { kind: "message"; text: string } => {
  const text = message.trim();
  return text === "/quit" ? { kind: "quit" } : { kind: "message", text };
};

/**
 * The number of rounds the answer at the round limit adds, or null when the answer is not a whole number
 * in 1..2^31-1 (finding 5: a longer integer overflowed the limit).
 */
export const parseExtraRounds = (reply: string): number | null => {
  const trimmed = reply.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed) || trimmed.length > 10) return null;
  const value = Number(trimmed);
  return value <= 2 ** 31 - 1 ? value : null;
};

/** The answer at the pause of issue #30 (prompts.unchangedPrompt): its letter or its word; anything else is no answer. */
export const parseUnchangedAnswer = (reply: string): "retry" | "proceed" | "stop" | null => {
  const t = reply.trim().toLowerCase();
  const answers = ["retry", "proceed", "stop"] as const;
  return answers.find((a) => t === UNCHANGED_ANSWERS[a] || t === a) ?? null;
};

export const chooseOption = (reply: string, count: number): number | null => {
  const trimmed = reply.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) return null;
  const index = Number(trimmed) - 1;
  return index < count ? index : null;
};

/** What a message of the interview means beyond quitting: nothing, the end of the interview, or text. */
export const parseInterviewMessage = (message: string): { kind: "empty" } | { kind: "done" } | { kind: "text"; text: string } => {
  const text = message.trim();
  if (text === "") return { kind: "empty" };
  if (text === "/done") return { kind: "done" };
  return { kind: "text", text };
};

/** The fold of the interview's line protocol: one line is a message; `"""` on its own opens and closes a block. */
export type LineFold = Readonly<{ block: boolean; lines: readonly string[]; complete: boolean }>;
export const emptyFold: LineFold = { block: false, lines: [], complete: false };
export const foldLine = (fold: LineFold, line: string): LineFold => {
  if (fold.complete) return fold;
  if (line.trim() === '"""') return fold.block ? { ...fold, complete: true } : { ...fold, block: true };
  return { ...fold, lines: [...fold.lines, line], complete: !fold.block };
};

// ---- decision support ---------------------------------------------------------------------------

/** The offer's command (D1 of the decision-support plan): "Help me decide" sends it, and the terminal user types it. */
export const DECIDE = "/decide";
export const isDecide = (text: string): boolean => text.trim() === DECIDE;

/** The text a reply stands for when it chooses one of the options by number ("label: description"); any other reply is itself. */
export const answerOf = (reply: string, options: readonly Readonly<{ label: string; description: string }>[]): string => {
  const chosen = chooseOption(reply, options.length);
  if (chosen === null) return reply;
  const option = options[chosen];
  return option.description === "" ? option.label : `${option.label}: ${option.description}`;
};
