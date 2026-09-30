// S62 (W9-R1-1, P10-R1-1, P10-R1-2): the answered question in the transcript keeps the exact text of its plain fields.
// questionMarkdown is rendered whole by the page's renderer, and each plain field's text is compared with the pane's
// rendering of the same field (textHtml, parsed): the question, the options' tokens, labels and descriptions, the terms
// and their explanations.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { markdownText, questionMarkdown } from "../../src/render.ts";
import type { PresentedQuestion } from "../../src/question.ts";
import { render } from "./markdown.ts";
import { markTerms, textHtml } from "./terms.ts";

/** The text the pane shows for a plain field: textHtml's HTML, parsed as the browser parses it. */
const paneText = (field: string): string => {
  const el = document.createElement("div");
  el.innerHTML = textHtml(field).replace(/\r\n?/g, "\n");
  return el.textContent ?? "";
};
const question = (fields: { question?: string; label?: string; description?: string; term?: string; explanation?: string; context?: string }): PresentedQuestion => ({
  number: 1,
  origin: { kind: "relayed" },
  context: { text: fields.context ?? "c", by: "agent" },
  terms: fields.term === undefined ? [] : [{ term: fields.term, explanation: fields.explanation ?? "e" }],
  question: fields.question ?? "Q?",
  options: [{ label: fields.label ?? "L", description: fields.description ?? "D", answer: { token: "1" } }],
  details: "",
  decision: null,
});
const rendered = (q: PresentedQuestion): HTMLElement => {
  const el = document.createElement("div");
  el.innerHTML = render(questionMarkdown(q));
  return el;
};
/** The parts of the rendered exchange that come from plain fields. */
const parts = (el: HTMLElement) => {
  const lists = [...el.querySelectorAll("ul")];
  const optionItem = lists[lists.length - 1].querySelector("li")!;
  const questionStrong = lists[lists.length - 1].previousElementSibling!.querySelector("strong")!;
  const termItem = lists.length > 1 ? lists[0].querySelector("li") : null;
  return {
    question: questionStrong.textContent ?? "",
    label: optionItem.querySelector("strong")?.textContent ?? "",
    option: optionItem.textContent ?? "",
    term: termItem?.querySelector("strong")?.textContent ?? null,
    termItem: termItem?.textContent ?? null,
  };
};
const ALLOWED = new Set(["P", "STRONG", "EM", "UL", "LI"]);
const foreign = (el: HTMLElement) => [...el.querySelectorAll("*")].map((e) => e.tagName).filter((t) => !ALLOWED.has(t));

const hostile = [
  "Should we keep <cache> as the element name?",
  "Keep <cache>",
  "Use <store>",
  "*x* and a_b_c",
  "a single ` backtick",
  "[x](y)",
  "&lt; stays",
  "a \\ backslash",
  "# heading",
  "- item",
  "1. item",
  "http://localhost",
  "https://example.org/x",
  "www.example.com",
  "someone@example.org",
  "Should we keep\n\nthis name?",
  "Keep this\n\n    literal text",
  "two spaces  \nthen a line",
  "a\r\nb",
  " Which? ",
  " SQLite ",
  " cache ",
];

describe("questionMarkdown in the page", () => {
  for (const field of hostile) {
    test(`every plain field keeps its text exactly: ${JSON.stringify(field)}`, () => {
      const el = rendered(question({ question: field, label: field, description: field, term: field, explanation: field }));
      const p = parts(el);
      expect(p.question).toBe(paneText(field));
      expect(p.label).toBe(paneText(field));
      expect(p.option).toBe(`1. ${paneText(field)} — ${paneText(field)}`);
      expect(p.term).toBe(paneText(field));
      expect(p.termItem).toBe(`${paneText(field)}: ${paneText(field)}`);
      expect(foreign(el)).toEqual([]);
      expect(el.textContent).not.toContain("**");
    });
  }

  test("the context stays Markdown", () => {
    const el = rendered(question({ context: "The **bold** word." }));
    expect(el.querySelectorAll("p")[1].querySelector("strong")?.textContent).toBe("bold");
  });

  test("an empty question adds no line and no element", () => {
    const el = rendered(question({ question: "" }));
    expect(foreign(el)).toEqual([]);
    expect([...el.querySelectorAll("p > strong")].map((s) => s.textContent)).toEqual(["Question 1"]);
  });

  // The question is non-empty here: an empty one has no line (the example above).
  test("property: arbitrary fields add no element and keep their text", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string(), fc.string(), fc.string(), fc.string(), (q, l, d, t, x) => {
        const el = rendered(question({ question: q, label: l, description: d, term: t, explanation: x }));
        const p = parts(el);
        return foreign(el).length === 0 && p.question === paneText(q) && p.label === paneText(l) && p.term === paneText(t) && p.termItem === (x === "" ? paneText(t) : `${paneText(t)}: ${paneText(x)}`);
      }),
      { numRuns: 500 },
    );
  });

  test("the seam: a term with a line break or special characters is marked in the question and in an option", () => {
    for (const term of ["cache\nkey", "<cache>", "http://localhost"]) {
      const q = question({ question: `Should we keep ${term} now?`, label: `Keep ${term} as it is`, term });
      const el = document.createElement("div");
      el.innerHTML = markTerms(render(questionMarkdown(q)), q.terms);
      const marked = [...el.querySelectorAll(".term")].map((m) => m.closest("li, p")?.textContent ?? "");
      expect(marked.some((t) => t.startsWith("Should we keep")), term).toBe(true);
      expect(marked.some((t) => t.startsWith("1. Keep")), term).toBe(true);
    }
  });

  test("markdownText of a plain text keeps it on one Markdown line", () => {
    expect(markdownText("a\n\nb")).not.toContain("\n");
  });
});
