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

  // S44 (W3-R1-1): the tooltip of a term inside a link is not inside the link.
  test("the tooltip of a link's term is not a descendant of the link", () => {
    const root = show("Use [zod](https://zod.dev).", [{ term: "zod", explanation: "A library." }]);
    focus(root.querySelector<HTMLAnchorElement>("a")!);
    expect(tooltip()!.closest("a")).toBe(null);
    expect(root.contains(tooltip())).toBe(false);
  });

  test("a link without a term opens nothing", () => {
    const root = show("See [the docs](https://example.org) about zod.", [{ term: "zod", explanation: "A library." }]);
    focus(root.querySelector<HTMLAnchorElement>("a")!);
    expect(tooltip()).toBe(null);
  });
});

// S42 (W2-R1-5, P3-R1-3): keyboard focus is routed into a term's tooltip and out after its anchor, never back into the
// tooltip; Shift+Tab and Escape there return to the term.
describe("TermText and the keyboard", () => {
  const long = "A long explanation. ".repeat(80);
  const terms = [{ term: "SQLite", explanation: long }, { term: "database", explanation: "Data kept for later use." }];
  const withButton = (markdown: string, ts: readonly Term[]) => {
    const root = show(markdown, ts);
    const after = document.createElement("button");
    after.textContent = "After";
    document.body.appendChild(after);
    return { root, after };
  };
  const key = (el: Element, k: string, shift = false) => {
    const e = new KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    flushSync();
    return e;
  };

  test("Tab from a term with its tooltip open enters the tooltip, which stays open", () => {
    const { root } = withButton("SQLite keeps the database.", terms);
    const [first] = root.querySelectorAll<HTMLElement>(".term");
    focus(first);
    const e = key(first, "Tab");
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(tooltip());
    expect(tooltip()!.textContent).toContain("A long explanation.");
  });

  test("the next Tab moves to the second term, and the first tooltip closes", () => {
    const { root } = withButton("SQLite keeps the database.", terms);
    const [first, second] = root.querySelectorAll<HTMLElement>(".term");
    focus(first);
    key(first, "Tab");
    const e = key(tooltip()!, "Tab");
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(second);
    expect(tooltip()?.textContent ?? "").not.toContain("A long explanation.");
  });

  for (const [name, k, shift] of [["Shift+Tab", "Tab", true], ["Escape", "Escape", false]] as const) {
    test(`${name} in the tooltip closes it and returns focus to the term`, () => {
      const { root } = withButton("SQLite keeps the database.", terms);
      const [first] = root.querySelectorAll<HTMLElement>(".term");
      focus(first);
      key(first, "Tab");
      key(tooltip()!, k, shift);
      expect(document.activeElement).toBe(first);
      expect(tooltip()).toBe(null);
    });
  }

  test("focus moving from the tooltip to anything outside both closes it", () => {
    const { root, after } = withButton("SQLite keeps the database.", terms);
    const [first] = root.querySelectorAll<HTMLElement>(".term");
    focus(first);
    key(first, "Tab");
    after.focus();
    flushSync();
    expect(tooltip()).toBe(null);
  });

  test("Tab from the last term's tooltip reaches the following button, not the tooltip itself", () => {
    const { root, after } = withButton("The database is SQLite", terms);
    const marks = root.querySelectorAll<HTMLElement>(".term");
    const last = marks[marks.length - 1];
    focus(last);
    key(last, "Tab");
    expect(document.activeElement).toBe(tooltip());
    key(tooltip()!, "Tab");
    expect(document.activeElement).toBe(after);
    expect(tooltip()).toBe(null);
  });

  test("a link that ends the text with one term: Tab enters its tooltip, and the next Tab reaches the following button", () => {
    const { root, after } = withButton("Use [zod](https://zod.dev)", [{ term: "zod", explanation: long }]);
    const link = root.querySelector<HTMLAnchorElement>("a")!;
    focus(link);
    key(link, "Tab");
    expect(document.activeElement).toBe(tooltip());
    key(tooltip()!, "Tab");
    expect(document.activeElement).toBe(after);
    expect(tooltip()).toBe(null);
  });
});
