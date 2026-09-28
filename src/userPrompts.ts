// The widget catalog of the prompts to the user (plan step 1.3): for each text of src/prompts.ts, its fixed
// choices with the exact text each sends, whether free text is meaningful, and the quit of its input mode.
// The web page renders a prompt from this entry; the terminal is unaffected. Pure.

import { DECIDE } from "./input.ts";
import * as prompts from "./prompts.ts";

export type Choice = Readonly<{ label: string; sends: string }>;
export type PromptKind = "decision" | "limit" | "limitNoProceed" | "execInput" | "optionOrText" | "permission" | "interviewMessage" | "confirmSummary" | "startOrTalk" | "unknown";
/** Choices that come from the preceding event rather than from the text: a relayed question's options, or the interview's numbered answers. */
export type Extra = "none" | "questionOptions" | "numberedAnswers";
export type UserPrompt = Readonly<{
  kind: PromptKind;
  text: string;
  /** `ask` prompts quit on "q" (parseAskLine), `message` prompts on "/quit" (parseMessage). */
  mode: "ask" | "message";
  choices: readonly Choice[];
  free: "none" | "line" | "message";
  extra: Extra;
}>;

const QUIT_ASK: Choice = { label: "Quit", sends: "q" };
const QUIT_MESSAGE: Choice = { label: "Quit", sends: "/quit" };
const entry = (kind: PromptKind, text: string, mode: UserPrompt["mode"], choices: readonly Choice[], free: UserPrompt["free"], extra: Extra = "none"): UserPrompt => ({
  kind,
  text,
  mode,
  choices: [...choices, mode === "ask" ? QUIT_ASK : QUIT_MESSAGE],
  free,
  extra,
});

// The texts with parameters, recognised by their fixed parts (built from src/prompts.ts, so they cannot drift).
const DECISION = prompts.decisionPrompt("\u0000").split("\u0000");
const LIMIT = prompts.limitPrompt(0, "\u0000").split("\u0000");
const LIMIT_PREFIX = LIMIT[0].replace(/^0/, "");
const NO_PROCEED = prompts.limitNoProceedPrompt(0).replace(/^0/, "");
/** The text after a leading whole number, or null when the text does not begin with one. */
const afterNumber = (text: string): string | null => {
  const match = /^[0-9]+/.exec(text);
  return match === null ? null : text.slice(match[0].length);
};

const FIXED: ReadonlyMap<string, (text: string) => UserPrompt> = new Map([
  [prompts.execInputPrompt, (t: string) => entry("execInput", t, "ask", [], "line")],
  [prompts.optionOrTextPrompt, (t: string) => entry("optionOrText", t, "ask", [], "line", "questionOptions")],
  [prompts.permissionPrompt, (t: string) => entry("permission", t, "ask", [{ label: "Allow", sends: "y" }, { label: "Deny", sends: "n" }], "none")],
  [prompts.interviewMessagePrompt, (t: string) => entry("interviewMessage", t, "message", [{ label: prompts.END_CLARIFICATION, sends: "/done" }], "message", "numberedAnswers")],
  [prompts.confirmSummaryPrompt, (t: string) => entry("confirmSummary", t, "message", [{ label: "Confirm", sends: "" }], "message")],
  [prompts.startOrTalkPrompt, (t: string) => entry("startOrTalk", t, "message", [{ label: "Start planning", sends: "" }], "message")],
]);

/**
 * The widget of a prompt text. Total: a text that is not in the catalog is free text plus Quit. A text with the offer
 * line (decision support, D1) is the entry of the rest with "Help me decide" before Quit.
 */
export const promptOf = (text: string): UserPrompt => {
  const offer = prompts.withoutOffer(text);
  if (!offer.offered) return promptOfText(text);
  const entry = promptOfText(offer.text);
  const quit = entry.choices[entry.choices.length - 1];
  return { ...entry, text, choices: [...entry.choices.slice(0, -1), { label: prompts.HELP_ME_DECIDE, sends: DECIDE }, quit] };
};

const promptOfText = (text: string): UserPrompt => {
  const fixed = FIXED.get(text);
  if (fixed !== undefined) return fixed(text);
  if (text.startsWith(DECISION[0]) && text.endsWith(DECISION[1]) && text.length >= DECISION[0].length + DECISION[1].length) return entry("decision", text, "ask", [{ label: "No decision", sends: "" }], "line", "questionOptions");
  const rest = afterNumber(text);
  if (rest !== null && rest === NO_PROCEED) return entry("limitNoProceed", text, "ask", [{ label: "Stop", sends: "0" }], "line");
  if (rest !== null && rest.startsWith(LIMIT_PREFIX) && rest.endsWith(LIMIT[1]) && rest.length >= LIMIT_PREFIX.length + LIMIT[1].length)
    return entry("limit", text, "ask", [{ label: "Proceed", sends: "p" }, { label: "Stop", sends: "0" }], "line");
  return entry("unknown", text, "ask", [], "line");
};

const NUMBERED_LINE = /^\s*([1-9][0-9]*)[.):]\s+(\S.*)$/;
/** The numbered proposed answers of an interview message (`<n>. <answer>`, one per line; `<n>)` and `<n>:` tolerated), as choices sending the number. */
export const numberedChoices = (message: string): readonly Choice[] =>
  message.split("\n").flatMap((line) => {
    const match = NUMBERED_LINE.exec(line.trimEnd());
    return match === null ? [] : [{ label: line.trim(), sends: match[1] }];
  });
/**
 * The numbered answers of an interview message as options (W2-R1-2): the label is the text after the number marker up
 * to a " - " or " — " separator, the description the rest. Choosing by label then matches what the user reads.
 */
export const numberedOptionLabels = (message: string): readonly Readonly<{ label: string; description: string }>[] =>
  message.split("\n").flatMap((line) => {
    const match = NUMBERED_LINE.exec(line.trimEnd());
    if (match === null) return [];
    const [label, ...rest] = match[2].split(/ [-—] /);
    return [{ label: label.trim(), description: rest.join(" - ").trim() }];
  });
