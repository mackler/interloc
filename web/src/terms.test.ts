// S28 (issue #36, decision Q5): the terms of a question are marked on every case-sensitive, whole-word occurrence, in
// the sanitized HTML, by the occurrence function the validation uses.
import { describe, expect, test } from "vitest";
import { markTerms } from "./terms.ts";
import { render } from "./markdown.ts";
import { termOccurrences } from "../../src/question.ts";

const terms = [{ term: "zod", explanation: "A library." }, { term: "report step", explanation: "A tool." }];
const marked = (html: string) => {
  const el = document.createElement("div");
  el.innerHTML = markTerms(html, terms);
  return el;
};

describe("markTerms", () => {
  test("every whole-word, case-sensitive occurrence is wrapped in a focusable term naming its index", () => {
    const el = marked(render("zod checks data; zodiac and Zod do not, but **zod** does. The report step too."));
    const found = [...el.querySelectorAll<HTMLElement>(".term")].map((t) => [t.textContent, t.dataset.term, t.tabIndex]);
    expect(found).toEqual([["zod", "0", 0], ["zod", "0", 0], ["report step", "1", 0]]);
    // The seam: the occurrences marked are those termOccurrences finds.
    const text = "zod checks data; zodiac and Zod do not, but zod does.";
    expect(termOccurrences(text, "zod").length).toBe(2);
  });

  test("the marking comes after sanitizing: a term's text is inserted as text", () => {
    const el = marked(render("[zod](https://zod.dev) and zod <img src=x onerror=alert(1)>"));
    expect(el.querySelectorAll(".term").length).toBe(2);
    expect(el.innerHTML).not.toMatch(/onerror/);
    const hostile = document.createElement("div");
    hostile.innerHTML = markTerms("<p>a &lt;b&gt; b</p>", [{ term: "<b>", explanation: "x" }]);
    expect(hostile.querySelector("b")).toBe(null);
    expect(hostile.querySelector(".term")?.textContent).toBe("<b>");
  });

  // S40 (W2-R1-3): a term inside a link is marked too, without a focus stop of its own; the link stays a working link.
  test("a term inside a link is marked without tabindex, and the link keeps its href and its focus", () => {
    const el = marked(render("Use [zod](https://zod.dev)."));
    const link = el.querySelector<HTMLAnchorElement>("a")!;
    expect(link.getAttribute("href")).toBe("https://zod.dev");
    const mark = link.querySelector<HTMLElement>(".term")!;
    expect(mark.textContent).toBe("zod");
    expect(mark.hasAttribute("tabindex")).toBe(false);
    expect(mark.dataset.term).toBe("0");
    const two = document.createElement("div");
    two.innerHTML = markTerms(render("[SQLite database](https://example.org)"), [{ term: "SQLite", explanation: "An engine." }, { term: "database", explanation: "Stored data." }]);
    expect([...two.querySelectorAll<HTMLElement>("a .term")].map((m) => [m.textContent, m.hasAttribute("tabindex")])).toEqual([["SQLite", false], ["database", false]]);
  });

  test("without terms the HTML is unchanged", () => {
    expect(markTerms("<p>zod</p>", [])).toBe("<p>zod</p>");
  });
});
