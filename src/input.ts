// Pure interpretation of what the user types. No I/O; used by the terminal Ui and the agent adapters.

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

export const chooseOption = (reply: string, count: number): number | null => {
  const trimmed = reply.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) return null;
  const index = Number(trimmed) - 1;
  return index < count ? index : null;
};
