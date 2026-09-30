// A question put to the user (S2 and following): its parts, and the mechanical part of the rules of QUESTION_RULES in
// src/prompts.ts. Pure; also imported by the browser (the occurrence of a term, which the page marks as validated here).
import { Result } from "effect";
import { QuestionInvalid } from "./errors.ts";
import { type QuestionProblem, TERMS_HEADING } from "./prompts.ts";
import type { Disposition, Issue, LogEntry, QuestionOption, Term } from "./schema.ts";

export type { QuestionOption, Term };

/**
 * The parts of a question that an agent writes: the context paragraph, the question, its terms and its options; `details`,
 * what the question is about as the program records it (S11), is text a term may occur in too.
 */
export type Question = Readonly<{ context: string; question: string; terms: readonly Term[]; options: readonly QuestionOption[]; details?: string }>;

const WORD = /[\p{L}\p{N}_]/u;
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The start of every case-sensitive, whole-word occurrence of `term` in `text` (issue #36, Q5). */
export const termOccurrences = (text: string, term: string): readonly number[] =>
  term === ""
    ? []
    : [...text.matchAll(new RegExp(escape(term), "gu"))]
        .map((m) => m.index)
        .filter((i) => !WORD.test(text.slice(i - 1, i)) && !WORD.test(text.slice(i + term.length, i + term.length + 1)));

/** Words that stand before a number without saying what it numbers ("see #53", "the #6"). */
const NOT_A_KIND = new Set(["a", "an", "the", "and", "or", "of", "in", "on", "at", "to", "by", "for", "from", "with", "as", "see", "per", "via"]);
/** A reference like "#53" without the kind of thing it numbers before it; "Issues #6, #33 and #28" names its kind once. */
const bareNumbers = (text: string): readonly string[] =>
  [...text.matchAll(/#\d+/gu)].flatMap((m) => {
    const before = text.slice(0, m.index).replace(/(?:#\d+\s*(?:,\s*(?:and\s+|or\s+)?|and\s+|or\s+))+$/u, "");
    const kind = /(\p{L}+)\s+$/u.exec(before);
    return kind !== null && !NOT_A_KIND.has(kind[1].toLowerCase()) ? [] : [m[0]];
  });

/** Every text of a question that its terms may occur in and that is shown to the reader. */
const textsOf = (q: Question): readonly string[] => [q.context, q.question, ...q.options.flatMap((o) => [o.label, o.description]), q.details ?? ""];
/**
 * The texts a term may occur in, as the reader sees them (S59): the fields the page renders as Markdown (the context and
 * the details) run by run, and the plain fields (the question and the options) as they are.
 */
const shownTexts = (q: Question): readonly string[] => [...markdownRuns(q.context), ...markdownRuns(q.details ?? ""), q.question, ...q.options.flatMap((o) => [o.label, o.description])];

/**
 * The problems of one question; none when it keeps every mechanically checkable rule. `scope` "context" checks only what
 * a context call writes (S9): the context and the terms; the program's own question and options are not its to change.
 */
export const questionProblems = (q: Question, scope: "all" | "context" = "all"): readonly QuestionProblem[] => {
  const texts = textsOf(q);
  const shown = shownTexts(q);
  const names = q.terms.map((t) => t.term);
  return [
    ...(q.context.trim() === "" ? [{ kind: "blankContext" as const, subject: "" }] : []),
    ...(scope === "context" || /\?["'”’)\]]*$/u.test(q.question.trim()) ? [] : [{ kind: "notLast" as const, subject: "" }]),
    ...q.terms.flatMap((t, i): QuestionProblem[] => {
      if (t.term.trim() === "") return [{ kind: "blankTerm", subject: "" }];
      return [
        ...(t.explanation.trim() === "" ? [{ kind: "blankExplanation" as const, subject: t.term }] : []),
        ...(shown.some((text) => termOccurrences(text, t.term).length > 0) ? [] : [{ kind: "termAbsent" as const, subject: t.term }]),
        ...(names.indexOf(t.term) < i ? [{ kind: "duplicateTerm" as const, subject: t.term }] : []),
      ];
    }),
    ...(scope === "context" ? [q.context] : texts).flatMap(bareNumbers).map((subject) => ({ kind: "bareNumber" as const, subject })),
  ];
};

/** Validates one question; `where` names it in the error ("questions_for_user 1", "Q3"). */
export const validateQuestion = (q: Question, where = "the question"): Result.Result<Question, QuestionInvalid> => {
  const problems = questionProblems(q);
  return problems.length === 0 ? Result.succeed(q) : Result.fail(new QuestionInvalid({ questions: [{ where, problems }] }));
};

/** Validates the questions of one reply together: every failing question is named in the one error. */
export const validateQuestions = (questions: readonly Readonly<{ where: string; question: Question }>[]): Result.Result<void, QuestionInvalid> => {
  const failing = questions.map(({ where, question }) => ({ where, problems: questionProblems(question) })).filter((q) => q.problems.length > 0);
  return failing.length === 0 ? Result.succeed(undefined) : Result.fail(new QuestionInvalid({ questions: failing }));
};

// ---- the one presentation of a question (S5, issues #46 and #57) ------------------------------------------------------

/** The pause of behaviour 7 that asks the question, with the ids and names it concerns (S5, S11). */
export type PauseOrigin =
  | Readonly<{ pause: "reraised"; id: string }>
  | Readonly<{ pause: "secondClarification"; id: string }>
  | Readonly<{ pause: "disputedSelfCorrection"; id: string }>
  | Readonly<{ pause: "reversal"; id: string; reverses: string }>
  | Readonly<{ pause: "repeatedUnderNewId"; id: string; repeats: string }>
  | Readonly<{ pause: "unexplained"; fileLabel: string; heading: string; round: number }>
  | Readonly<{ pause: "identical"; fileLabel: string }>
  | Readonly<{ pause: "idle"; idle: number }>;

/** A log entry of a pause's facts; its prose never shows the program's measurement (issue #31). */
export type ShownEntry = LogEntry;
/**
 * What a pause of behaviour 7 is about, as data (S11, issue #19): the ids of its origin, and the review issue, the
 * disposition and the earlier log entries that the user reads as prose (`pauseProse` in src/render.ts), never as JSON.
 */
export type PauseFacts =
  | Readonly<{ pause: "reraised"; id: string; history: readonly ShownEntry[]; issue: Issue | null }>
  | Readonly<{ pause: "secondClarification"; id: string; history: readonly ShownEntry[]; disposition: Disposition | null }>
  | Readonly<{ pause: "disputedSelfCorrection"; id: string; explanation: string; history: readonly ShownEntry[] }>
  | Readonly<{ pause: "reversal"; id: string; reverses: string; history: readonly ShownEntry[]; issue: Issue | null; disposition: Disposition | null }>
  | Readonly<{ pause: "repeatedUnderNewId"; id: string; repeats: string; history: readonly ShownEntry[]; issue: Issue | null }>
  | Readonly<{ pause: "unexplained"; fileLabel: string; heading: string; round: number; resultText: string }>
  | Readonly<{ pause: "identical"; fileLabel: string; round: number; seen: string }>
  | Readonly<{ pause: "idle"; idle: number; round: number; issues: readonly ShownEntry[] }>;
/** The ids a pause's origin keeps of its facts. */
export const pauseOriginOf = (facts: PauseFacts): PauseOrigin => {
  switch (facts.pause) {
    case "reraised":
    case "secondClarification":
    case "disputedSelfCorrection":
      return { pause: facts.pause, id: facts.id };
    case "reversal":
      return { pause: "reversal", id: facts.id, reverses: facts.reverses };
    case "repeatedUnderNewId":
      return { pause: "repeatedUnderNewId", id: facts.id, repeats: facts.repeats };
    case "unexplained":
      return { pause: "unexplained", fileLabel: facts.fileLabel, heading: facts.heading, round: facts.round };
    case "identical":
      return { pause: "identical", fileLabel: facts.fileLabel };
    case "idle":
      return { pause: "idle", idle: facts.idle };
  }
};

/**
 * What produced a question (S5): where it arose in the run, with what the record and the origin line need to name it.
 * A question inside decision k carries k in `PresentedQuestion.decision`, whatever its origin (issue #57).
 */
export type QuestionOrigin =
  /** An agreed question of the clarification, or a question asked there that is not in the list (a follow-up, an accepted requirements issue). */
  | Readonly<{ kind: "clarification"; id: string }>
  | Readonly<{ kind: "followUp"; id: string }>
  /** A turn of the clarification that asks no particular question: the user replies to Claude Code's message. */
  | Readonly<{ kind: "reply" }>
  /** The choice after an empty agreed list: start planning, or talk first. */
  | Readonly<{ kind: "startOrTalk" }>
  /** The confirmation of the summary of a clarification. */
  | Readonly<{ kind: "confirmSummary" }>
  /** A question Claude Code returns with a plan it writes or revises, or with a response to a review (`heading` names where). */
  | Readonly<{ kind: "planner"; heading: string }>
  /** A question Claude Code asks while implementing the plan. */
  | Readonly<{ kind: "relayed" }>
  /** An implementation that stopped without a question the user was asked. */
  | Readonly<{ kind: "execStop"; phase: number; status: string }>
  /** A permission request of Claude Code while implementing the plan. */
  | Readonly<{ kind: "permission"; tool: string; input: string }>
  | (Readonly<{ kind: "pause"; heading: string }> & PauseOrigin)
  | Readonly<{ kind: "limit"; heading: string; limit: number }>
  | Readonly<{ kind: "unchanged"; heading: string; fileLabel: string; accepted: readonly string[] }>
  | Readonly<{ kind: "transport"; agent: "claude" | "codex"; what: string; attempts: number; fault: string }>;

/** The exact text that chooses an option, or any whole number the user types (the more cycles at the cycle limit, S8). */
export type OptionAnswer = Readonly<{ token: string }> | Readonly<{ numeric: true }>;
export type PresentedOption = Readonly<{ label: string; description: string; answer: OptionAnswer }>;
/** Who wrote the context paragraph: an agent, or the program (a fixed paragraph, S7 and S10). */
export type QuestionContextText = Readonly<{ text: string; by: "agent" | "program" }>;
/** What the context call gives a question (S9): its context paragraph, by whom, and the explanations of its terms. */
export type ContextWritten = Readonly<{ context: QuestionContextText; terms: readonly Term[] }>;

/**
 * A question as the user is shown it (S5), the same shape whatever produced it: its number in the run, where it came
 * from, the context paragraph, the terms and their explanations, the question and the options that answer it, and the
 * decision it belongs to (issue #57), or null.
 */
export type PresentedQuestion = Readonly<{
  number: number;
  origin: QuestionOrigin;
  context: QuestionContextText;
  terms: readonly Term[];
  question: string;
  options: readonly PresentedOption[];
  /** What the question is about, in Markdown, shown with the context (S11): a pause's facts, the summary to confirm; "" when none. */
  details: string;
  decision: number | null;
}>;

// ---- a question relayed from AskUserQuestion (S13, G-R1-2) -------------------------------------------------------------

/**
 * The parts of a relayed question's text in the shape RELAYED_SHAPE of src/prompts.ts states: the context (one or more
 * paragraphs), the terms block when present, and the question, the last paragraph. Null when the text does not have
 * that shape or its parts break a mechanically checkable rule; the context is then written by a context call (S14).
 */
export const parseRelayedQuestion = (text: string, options: readonly QuestionOption[]): Question | null => {
  const blocks = text.trim().split(/\n[ \t]*\n/).map((b) => b.trim()).filter((b) => b !== "");
  if (blocks.length < 2) return null;
  const question = blocks[blocks.length - 1];
  const before = blocks.slice(0, -1);
  const at = before.findIndex((b) => b.split("\n")[0].trim() === TERMS_HEADING);
  const contextBlocks = at < 0 ? before : before.slice(0, at);
  const termBlocks = at < 0 ? [] : before.slice(at);
  const lines = termBlocks.join("\n").split("\n").slice(1).map((l) => l.trim()).filter((l) => l !== "");
  const terms = lines.map((line) => {
    const colon = line.indexOf(": ");
    return colon < 0 ? { term: line, explanation: "" } : { term: line.slice(0, colon).trim(), explanation: line.slice(colon + 2).trim() };
  });
  const parsed: Question = { context: contextBlocks.join("\n\n"), terms, question, options };
  return contextBlocks.length === 0 || questionProblems(parsed).length > 0 ? null : parsed;
};

// ---- the text the reader sees of a Markdown field (S59) ----------------------------------------------------------------

/*
 * The validation and the page's marking must read the same text (S59): what the reader sees of a Markdown field, split
 * into inline runs. An inline run is a maximal sequence of text in document order with no start or end of a block in
 * between; runs stay separate strings, since a term may contain a line break (a soft break within a paragraph). This is
 * a reading of CommonMark with GFM as the page's renderer (marked) applies it, for the constructs agents write: blocks
 * (paragraphs, headings, lists, quotations, fenced code, thematic breaks, HTML block tags) and inlines (code spans,
 * backslash escapes, entities, links, autolinks, HTML tags, emphasis). web/src/terms.test.ts holds the two to one
 * another on generated Markdown.
 */

/** The HTML elements that start or end a block, and so a run; `br`, a hard break, ends a run too. */
export const BLOCK_TAGS: ReadonlySet<string> = new Set(
  "address article aside blockquote br details dd div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table tbody td tfoot th thead tr ul".split(" "),
);

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", mdash: "—", ndash: "–", hellip: "…", laquo: "«", raquo: "»" };
const PUNCT = /[!-/:-@[-`{-~\p{P}\p{S}]/u;
const SPACE = /\s/u;

/** An inline token: text, a delimiter run of `*` or `_` (with its flanking), or the end of a run. */
type Inline = { kind: "text"; text: string } | { kind: "break" } | { kind: "delim"; ch: string; count: number; orig: number; open: boolean; close: boolean };

const flanking = (src: string, start: number, end: number, ch: string) => {
  const before = start === 0 ? " " : src[start - 1];
  const after = end >= src.length ? " " : src[end];
  const left = !SPACE.test(after) && (!PUNCT.test(after) || SPACE.test(before) || PUNCT.test(before));
  const right = !SPACE.test(before) && (!PUNCT.test(before) || SPACE.test(after) || PUNCT.test(after));
  return ch === "*" ? { open: left, close: right } : { open: left && (!right || PUNCT.test(before)), close: right && (!left || PUNCT.test(after)) };
};

/** The text inside the brackets of a link or image starting at `at`, and where the link ends; null when it is none. */
const linkAt = (src: string, at: number): { text: string; end: number } | null => {
  let depth = 0;
  let i = at;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "`") {
      const run = /^`+/.exec(src.slice(i))![0];
      const close = src.indexOf(run, i + run.length);
      if (close >= 0) i = close + run.length - 1;
    } else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) break;
  }
  if (depth !== 0 || src[i + 1] !== "(") return null;
  let paren = 0;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") j++;
    else if (c === "(") paren++;
    else if (c === ")" && --paren === 0) return { text: src.slice(at + 1, i), end: j + 1 };
    else if (c === "\n" && src[j + 1] === "\n") return null;
  }
  return null;
};

/** The inline tokens of a paragraph's text. */
const inlineTokens = (src: string): Inline[] => {
  const out: Inline[] = [];
  const text = (t: string) => out.push({ kind: "text", text: t });
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const rest = src.slice(i);
    if (c === "\\" && i + 1 < src.length && /[!-/:-@[-`{-~]/.test(src[i + 1])) {
      text(src[i + 1]);
      i += 2;
    } else if (c === "\\" && src[i + 1] === "\n") {
      out.push({ kind: "break" });
      i += 2;
    } else if (c === "`") {
      const run = /^`+/.exec(rest)![0];
      let close = -1;
      for (let j = i + run.length; j < src.length; ) {
        const m = /^`+/.exec(src.slice(j));
        if (m === null) j++;
        else if (m[0].length === run.length) {
          close = j;
          break;
        } else j += m[0].length;
      }
      if (close < 0) {
        text(run);
        i += run.length;
      } else {
        const body = src.slice(i + run.length, close).replace(/\n/g, " ");
        text(/^ .*[^ ].* $/su.test(body) ? body.slice(1, -1) : body);
        i = close + run.length;
      }
    } else if (c === "<") {
      const auto = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*)>/.exec(rest);
      const tag = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:\s[^<>]*)?\/?>/.exec(rest);
      const comment = /^<!--[\s\S]*?-->/.exec(rest);
      if (auto !== null) {
        text(auto[1]);
        i += auto[0].length;
      } else if (comment !== null) i += comment[0].length;
      else if (tag !== null) {
        if (BLOCK_TAGS.has(tag[1].toLowerCase())) out.push({ kind: "break" });
        i += tag[0].length;
      } else {
        text(c);
        i++;
      }
    } else if (c === "&") {
      const m = /^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]*));/.exec(rest);
      const code = m === null ? null : m[1] !== undefined ? Number(m[1]) : m[2] !== undefined ? parseInt(m[2], 16) : null;
      const named = m?.[3] === undefined ? undefined : ENTITIES[m[3]];
      if (m !== null && code !== null) {
        text(code === 0 || code > 0x10ffff ? "�" : String.fromCodePoint(code));
        i += m[0].length;
      } else if (m !== null && named !== undefined) {
        text(named);
        i += m[0].length;
      } else {
        text(c);
        i++;
      }
    } else if (c === "[" || (c === "!" && src[i + 1] === "[")) {
      const image = c === "!";
      const link = linkAt(src, image ? i + 1 : i);
      if (link === null) {
        text(c);
        i++;
      } else {
        // A link's text is inline content of its own, with no emphasis across its brackets; an image shows no text.
        if (!image) inlineRuns(link.text).forEach((r, k) => (k === 0 ? text(r) : (out.push({ kind: "break" }), text(r))));
        i = link.end;
      }
    } else if (c === "*" || c === "_") {
      const run = (c === "*" ? /^\*+/ : /^_+/).exec(rest)![0];
      out.push({ kind: "delim", ch: c, count: run.length, orig: run.length, ...flanking(src, i, i + run.length, c) });
      i += run.length;
    } else if (c === "\n") {
      text("\n");
      i++;
    } else {
      text(c);
      i++;
    }
  }
  return out;
};

/** CommonMark's processing of emphasis: matched delimiters are removed, the rest stay as text. */
const resolveEmphasis = (tokens: Inline[]): void => {
  const delims = tokens.filter((t): t is Extract<Inline, { kind: "delim" }> => t.kind === "delim");
  for (let c = 0; c < delims.length; c++) {
    const closer = delims[c];
    while (closer.close && closer.count > 0) {
      let o = c - 1;
      for (; o >= 0; o--) {
        const opener = delims[o];
        if (opener.ch !== closer.ch || !opener.open || opener.count === 0) continue;
        const odd = (opener.close || closer.open) && (opener.orig + closer.orig) % 3 === 0 && !(opener.orig % 3 === 0 && closer.orig % 3 === 0);
        if (!odd) break;
      }
      if (o < 0) break;
      const opener = delims[o];
      const use = opener.count >= 2 && closer.count >= 2 ? 2 : 1;
      opener.count -= use;
      closer.count -= use;
      for (let k = o + 1; k < c; k++) {
        delims[k].open = false;
        delims[k].close = false;
      }
    }
  }
};

/** The runs of one paragraph's inline content. */
const inlineRuns = (src: string): string[] => {
  const tokens = inlineTokens(src);
  resolveEmphasis(tokens);
  const runs: string[] = [""];
  for (const t of tokens) {
    if (t.kind === "break") runs.push("");
    else runs[runs.length - 1] += t.kind === "text" ? t.text : t.ch.repeat(t.count);
  }
  return runs;
};

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const QUOTE = /^ {0,3}> ?/;
const LIST = /^( {0,3})([-*+]|\d{1,9}[.)])( +|$)/;
const HEADING = /^ {0,3}(#{1,6})(?: +|$)(.*)$/;
const RULE = /^ {0,3}([-*_])(?: *\1){2,} *$/;
const blank = (line: string) => line.trim() === "";
const startsBlock = (line: string) => FENCE.test(line) || QUOTE.test(line) || HEADING.test(line) || RULE.test(line) || (LIST.test(line) && !blank(line.replace(LIST, "")));

/** The runs of a sequence of lines of block content. */
const blockRuns = (lines: readonly string[]): string[] => {
  const runs: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},} *$`).test(lines[i])) body.push(lines[i++]);
      i++;
      runs.push(body.length === 0 ? "" : `${body.join("\n")}\n`);
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && !blank(lines[i]) && (QUOTE.test(lines[i]) || inner.length > 0)) {
        if (!QUOTE.test(lines[i]) && startsBlock(lines[i])) break;
        inner.push(lines[i].replace(QUOTE, ""));
        i++;
        if (i < lines.length && QUOTE.test(lines[i]) && blank(lines[i].replace(QUOTE, ""))) {
          while (i < lines.length && QUOTE.test(lines[i]) && blank(lines[i].replace(QUOTE, ""))) {
            inner.push("");
            i++;
          }
          if (!(i < lines.length && QUOTE.test(lines[i]))) break;
        }
      }
      runs.push(...blockRuns(inner));
      continue;
    }
    const list = LIST.exec(line);
    if (list !== null && !blank(line.replace(LIST, ""))) {
      const indent = list[0].length;
      const item = [line.slice(indent)];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (blank(next)) {
          if (i + 1 < lines.length && /^\s/.test(lines[i + 1]) && lines[i + 1].length - lines[i + 1].trimStart().length >= indent) {
            item.push("");
            i++;
            continue;
          }
          break;
        }
        if (next.length - next.trimStart().length >= indent) item.push(next.slice(indent));
        else if (!startsBlock(next)) item.push(next);
        else break;
        i++;
      }
      runs.push(...blockRuns(item));
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      runs.push(...inlineRuns(heading[2].replace(/(?:^| +)#+ *$/, "").trim()));
      i++;
      continue;
    }
    if (RULE.test(line)) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !blank(lines[i]) && (para.length === 0 || !startsBlock(lines[i]))) {
      if (para.length > 0 && /^ {0,3}(=+|-+) *$/.test(lines[i])) {
        i++;
        break;
      }
      para.push(lines[i]);
      i++;
    }
    // Leading whitespace of each line is dropped; trailing spaces end a line as a soft break, two or more a hard one.
    const text = para.map((l, k) => {
      const t = l.trimStart();
      return k === para.length - 1 ? t.trimEnd() : / {2,}$/.test(t) ? `${t.trimEnd()}\\` : t.replace(/ +$/, "");
    });
    runs.push(...inlineRuns(text.join("\n")));
  }
  return runs;
};

/** The inline runs of a Markdown field as the reader sees them, each a separate string (S59); blank runs are left out. */
export const markdownRuns = (md: string): readonly string[] => blockRuns(md.replace(/\r\n?/g, "\n").split("\n")).filter((r) => r.trim() !== "");
