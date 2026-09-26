import { describe, expect, test } from "vitest";
import { initialLayout, observe, select } from "./layout.ts";

// Finding 7 of docs/gui-review.md, decision Q3: selectable panels at compact widths.
const seen = (left: number, right: number, prompt: number | null = null) => ({ counts: { left, right }, prompt });

describe("layout", () => {
  test("the left panel is selected at first", () => {
    expect(initialLayout.selected).toBe("left");
  });

  test("messages that arrive in the hidden panel are counted for its badge; the shown panel's are not", () => {
    const l = observe(observe(initialLayout, seen(2, 1), true), seen(3, 4), true);
    expect(l.unseen).toEqual({ left: 0, right: 4 });
  });

  test("selecting a panel shows it and clears its count", () => {
    const l = select(observe(initialLayout, seen(0, 5), true), "right");
    expect(l.selected).toBe("right");
    expect(l.unseen.right).toBe(0);
    const back = observe(l, seen(2, 5), true);
    expect(back.unseen).toEqual({ left: 2, right: 0 });
  });

  test("a new prompt selects the left panel, where it is answered", () => {
    const l = observe(select(initialLayout, "right"), seen(1, 0, 4), true);
    expect(l.selected).toBe("left");
    expect(observe(select(l, "right"), seen(1, 0, 4), true).selected).toBe("right");
  });

  test("at expanded width both panels show, so nothing is counted", () => {
    const l = observe(select(initialLayout, "right"), seen(3, 3, 1), false);
    expect(l.unseen).toEqual({ left: 0, right: 0 });
  });

  test("a new run (fewer messages than before) starts the counts again", () => {
    const l = observe(observe(initialLayout, seen(10, 10), true), seen(1, 0), true);
    expect(l.unseen).toEqual({ left: 0, right: 0 });
  });
});
