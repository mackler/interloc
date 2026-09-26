import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import ChatPanel from "./components/ChatPanel.svelte";
import type { Message } from "./state.ts";

// P3-R1-1: a panel hidden by the compact layout stays mounted; while hidden it ignores scroll events, and shown again
// it goes to its end if it was following. jsdom has no layout, so the list's geometry is stubbed.
let mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const m of mounted) unmount(m);
  mounted = [];
  document.body.innerHTML = "";
});
const message = (i: number): Message => ({ key: `k${i}`, author: "codex", heading: null, body: `message ${i}`, format: "text" });
const panel = (visible: boolean) => {
  const props = $state({ title: "Claude Code and Codex", messages: [message(0)], empty: "none", visible });
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(ChatPanel, { target, props }));
  flushSync();
  const list = target.querySelector<HTMLElement>(".list")!;
  let top = 0;
  Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => 1000 });
  Object.defineProperty(list, "clientHeight", { configurable: true, get: () => 200 });
  Object.defineProperty(list, "scrollTop", { configurable: true, get: () => top, set: (v: number) => void (top = v) });
  return { props, target, list, top: () => top };
};
const scrolledUp = (list: HTMLElement) => {
  list.scrollTop = 0;
  list.dispatchEvent(new Event("scroll"));
  flushSync();
};

describe("ChatPanel while hidden", () => {
  test("a shown panel scrolled up counts new messages on its chip", () => {
    const p = panel(true);
    scrolledUp(p.list);
    p.props.messages = [message(0), message(1), message(2)];
    flushSync();
    expect(p.target.textContent).toMatch(/2 new messages/);
  });

  test("a hidden panel ignores scroll events, so it keeps following; shown again, it goes to its end", async () => {
    const p = panel(false);
    scrolledUp(p.list);
    p.props.messages = [message(0), message(1), message(2)];
    flushSync();
    expect(p.target.textContent).not.toMatch(/new message/);
    p.props.visible = true;
    flushSync();
    await tick();
    await tick();
    expect(p.top()).toBe(1000);
  });
});
