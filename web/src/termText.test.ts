import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import TermText from "./components/TermText.svelte";
import { render } from "./markdown.ts";

// S40 (W2-R1-3, P3-R1-2): the terms inside a link are explained on hover of each mark, and focusing the link explains
// every term it contains.
let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const m of mounted) unmount(m);
  mounted = [];
  document.body.innerHTML = "";
});
type Term = { term: string; explanation: string };
const show = (markdown: string, terms: readonly Term[]) => {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(TermText, { target, props: { html: render(markdown), terms } }));
  flushSync();
  return target;
};
const tooltip = () => document.querySelector<HTMLElement>("[role=tooltip]");
const focus = (el: HTMLElement) => {
  el.focus();
  el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  flushSync();
};
const hover = (el: HTMLElement) => {
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  flushSync();
};

describe("TermText and the terms inside a link", () => {
  const terms = [{ term: "SQLite", explanation: "An engine that keeps a database in one file." }, { term: "database", explanation: "Data kept for later use." }];

  test("focusing a link with two terms opens one tooltip with both explanations, in order", () => {
    const root = show("Use a [SQLite database](https://example.org).", terms);
    const link = root.querySelector<HTMLAnchorElement>("a")!;
    focus(link);
    const tip = tooltip()!;
    expect(tip).not.toBe(null);
    const text = tip.textContent ?? "";
    expect(text).toContain("SQLite");
    expect(text).toContain(terms[0].explanation);
    expect(text).toContain("database");
    expect(text).toContain(terms[1].explanation);
    expect(text.indexOf(terms[0].explanation)).toBeLessThan(text.indexOf(terms[1].explanation));
    expect(link.getAttribute("aria-describedby")).toBe(tip.id);
  });

  test("hovering each mark inside the link opens that mark's own explanation", () => {
    const root = show("Use a [SQLite database](https://example.org).", terms);
    const marks = [...root.querySelectorAll<HTMLElement>("a .term")];
    hover(marks[1]);
    expect(tooltip()!.textContent).toContain(terms[1].explanation);
    expect(tooltip()!.textContent).not.toContain(terms[0].explanation);
    hover(marks[0]);
    expect(tooltip()!.textContent).toContain(terms[0].explanation);
    expect(tooltip()!.textContent).not.toContain(terms[1].explanation);
  });

  test("a link with one term shows that term alone; the link still works", () => {
    const root = show("Use [zod](https://zod.dev).", [{ term: "zod", explanation: "A library." }]);
    const link = root.querySelector<HTMLAnchorElement>("a")!;
    expect(link.getAttribute("href")).toBe("https://zod.dev");
    focus(link);
    expect(tooltip()!.textContent).toContain("A library.");
    expect(tooltip()!.querySelectorAll("strong").length).toBe(1);
  });

  test("a link without a term opens nothing", () => {
    const root = show("See [the docs](https://example.org) about zod.", [{ term: "zod", explanation: "A library." }]);
    focus(root.querySelector<HTMLAnchorElement>("a")!);
    expect(tooltip()).toBe(null);
  });
});
