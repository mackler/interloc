import { describe, expect, test } from "vitest";
import { nextFocusable } from "./focus.ts";

// S42 (P3-R1-3): the element Tab reaches after a tooltip's anchor, the closing tooltip excluded.
describe("nextFocusable", () => {
  const el = (id: string) => ({ id, inside: [] as string[] });
  type E = ReturnType<typeof el>;
  const contains = (container: E) => (e: E) => e === container || e.inside.includes(container.id);
  const anchor = el("anchor");
  const tip = el("tip");
  const inTip = { id: "link-in-tip", inside: ["tip"] };
  const after = el("after");

  test("the tooltip right after its anchor, and anything inside it, are skipped", () => {
    expect(nextFocusable([el("before"), anchor, tip, inTip, after], anchor, contains(tip))).toBe(after);
  });

  test("nothing follows: null, so the browser's default applies", () => {
    expect(nextFocusable([anchor, tip], anchor, contains(tip))).toBe(null);
  });

  test("an anchor not in the list: null", () => {
    expect(nextFocusable([tip, after], anchor, contains(tip))).toBe(null);
  });
});
