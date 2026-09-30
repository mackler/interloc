// S28 (issue #36, decision Q5): the terms of a question are marked on every case-sensitive, whole-word occurrence, in
// the sanitized HTML, by the occurrence function the validation uses.
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { domRuns, markTerms } from "./terms.ts";
import { markdownRuns, questionProblems } from "../../src/question.ts";
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

// S59 (W8-R1-1, P9-R1-2): a term split by inline markup is marked across its fragments, within one inline run.
describe("markTerms across inline markup", () => {
  const marks = (markdown: string, term: string) => {
    const el = document.createElement("div");
    el.innerHTML = markTerms(render(markdown), [{ term, explanation: "x" }]);
    return { el, fragments: [...el.querySelectorAll<HTMLElement>(".term")] };
  };
  test("'cache **key**' is one occurrence of two fragments, one tab stop, the strong kept", () => {
    const { el, fragments } = marks("The cache **key** identifies the saved result.", "cache key");
    expect(fragments.map((f) => f.textContent)).toEqual(["cache ", "key"]);
    expect(new Set(fragments.map((f) => f.dataset.term))).toEqual(new Set(["0"]));
    expect(new Set(fragments.map((f) => f.dataset.occurrence)).size).toBe(1);
    expect(fragments.map((f) => f.hasAttribute("tabindex"))).toEqual([true, false]);
    expect(el.querySelector("strong")?.textContent).toBe("key");
  });
  test("split by em and by inline code; inside a link no fragment is a tab stop", () => {
    expect(marks("The *cache* key here.", "cache key").fragments.map((f) => f.textContent)).toEqual(["cache", " key"]);
    expect(marks("The `cache` key here.", "cache key").fragments.map((f) => f.textContent)).toEqual(["cache", " key"]);
    const link = marks("See [the cache **key**](https://example.org).", "cache key").fragments;
    expect(link.map((f) => f.textContent)).toEqual(["cache ", "key"]);
    expect(link.some((f) => f.hasAttribute("tabindex"))).toBe(false);
  });
  test("a term with a soft break is marked within one paragraph, never across blocks", () => {
    expect(marks("The cache\nkey here.", "cache\nkey").fragments.map((f) => f.textContent)).toEqual(["cache\nkey"]);
    for (const md of ["The cache\n\nkey here.", "- cache\n- key", "> cache\n>\n> > unrelated\n>\n> key"]) expect(marks(md, "cache\nkey").fragments, md).toEqual([]);
    const el = document.createElement("div");
    el.innerHTML = markTerms("<blockquote>cache <p>unrelated paragraph</p>key</blockquote>", [{ term: "cache key", explanation: "x" }]);
    expect(el.querySelectorAll(".term").length).toBe(0);
  });
});

// S59: the seam. The page's inline runs are markdownRuns'; the marked ranges are termOccurrences' in each run alone; a
// term passes the validation of a Markdown field exactly when the page marks it.
describe("the seam of the validation and the marking", () => {
  const word = fc.constantFrom("cache", "key", "zod", "a", "b");
  const inline = fc.oneof(
    { weight: 4, arbitrary: word },
    fc.tuple(word, word).map(([x, y]) => `*${x} ${y}*`),
    fc.tuple(word, word).map(([x, y]) => `**${x} ${y}**`),
    word.map((x) => `_${x}_`),
    fc.tuple(word, word).map(([x, y]) => `\`${x} ${y}\``),
    fc.tuple(word, word).map(([x, y]) => `[${x} **${y}**](https://example.org)`),
    fc.constantFrom("\\*", "\\_", "&amp;"),
  );
  const line = fc.array(inline, { minLength: 1, maxLength: 5 }).map((ws) => ws.join(" "));
  const paragraph = fc.array(line, { minLength: 1, maxLength: 3 }).map((ls) => ls.join("\n"));
  const block = fc.oneof(
    { weight: 3, arbitrary: paragraph },
    fc.array(line, { minLength: 1, maxLength: 3 }).map((ls) => ls.map((l) => `- ${l}`).join("\n")),
    paragraph.map((p) => p.split("\n").map((l) => `> ${l}`).join("\n")),
    fc.tuple(line, line).map(([x, y]) => `> ${x}\n>\n> > ${y}`),
  );
  const markdown = fc.array(block, { minLength: 1, maxLength: 4 }).map((bs) => bs.join("\n\n"));
  const term = fc.constantFrom("cache key", "cache\nkey", "zod", "key", "a b", "*");

  test("property: DOM runs equal markdownRuns; marked ranges are termOccurrences per run; validation agrees", () => {
    fc.assert(
      fc.property(markdown, term, (md, t) => {
        const html = render(md);
        const root = document.createElement("div");
        root.innerHTML = html;
        const runs = domRuns(root);
        expect(runs).toEqual([...markdownRuns(md)]);
        const el = document.createElement("div");
        el.innerHTML = markTerms(html, [{ term: t, explanation: "x" }]);
        const occurrences = new Set([...el.querySelectorAll<HTMLElement>(".term")].map((f) => f.dataset.occurrence));
        const expected = runs.reduce((n, r) => n + termOccurrences(r, t).length, 0);
        expect(occurrences.size).toBe(expected);
        const valid = questionProblems({ context: md, question: "Q?", terms: [{ term: t, explanation: "x" }], options: [] }, "context").every((p) => p.kind !== "termAbsent");
        expect(valid).toBe(expected > 0);
      }),
      { numRuns: 400 },
    );
  });
});
