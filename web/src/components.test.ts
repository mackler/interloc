import { type Component, flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as prompts from "../../src/prompts.ts";
import { promptOf } from "../../src/userPrompts.ts";
import DirectoryDialog from "./components/DirectoryDialog.svelte";
import PromptWidget from "./components/PromptWidget.svelte";
import StartForm from "./components/StartForm.svelte";
import TimelineRail from "./components/TimelineRail.svelte";
import TopBar from "./components/TopBar.svelte";
import MessageView from "./components/Message.svelte";
import ChatPanel from "./components/ChatPanel.svelte";
import { clockTime, fullTime } from "./time.ts";
import { emptyRun, initialState, type Message, reduce, type Widget } from "./state.ts";

// Plan step 4.5: the components, mounted in jsdom.
let mounted: ReturnType<typeof mount>[] = [];
const show = <P extends Record<string, any>>(component: Component<P>, props: P) => {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(component, { target, props }));
  flushSync();
  return target;
};
afterEach(() => {
  for (const m of mounted) unmount(m);
  mounted = [];
  document.body.innerHTML = "";
  localStorage.clear();
});
const one = (root: ParentNode, selector: string): HTMLElement => {
  const el = root.querySelector<HTMLElement>(selector);
  if (el === null) throw new Error(`no element matching ${selector}`);
  return el;
};
const type = (el: HTMLInputElement | HTMLTextAreaElement, text: string) => {
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
};
const widget = (text: string, options: Widget["options"] = []): Widget => {
  const asked = { _tag: "Asked" as const, prompt: 7, ...promptOf(text) };
  return { asked, options, choices: asked.choices };
};

// Issue #1: a message's time, shown in its header or, when grouped, given to assistive technology only.
describe("Message", () => {
  const ISO = "2026-09-27T14:03:27.000Z";
  const m = (showTime: boolean): Message => ({ key: "1-1", author: "codex", heading: "Plan review, round 1", body: "No issue.", format: "text", time: ISO, showTime });

  test("a shown time is in the header as <time datetime title>, visible", () => {
    const root = show(MessageView, { message: m(true) });
    const time = one(root, "header time") as HTMLTimeElement;
    expect(time.getAttribute("datetime")).toBe(ISO);
    expect(time.getAttribute("title")).toBe(fullTime(ISO));
    expect(time.textContent?.trim()).toBe(clockTime(ISO));
    expect(time.closest(".visually-hidden")).toBe(null);
  });

  test("a grouped message keeps its time for assistive technology and the title, visually hidden", () => {
    const root = show(MessageView, { message: m(false) });
    const time = one(root, "time") as HTMLTimeElement;
    expect(time.getAttribute("datetime")).toBe(ISO);
    expect(time.getAttribute("title")).toBe(fullTime(ISO));
    expect(time.textContent?.trim()).toBe(clockTime(ISO));
    expect(time.closest(".visually-hidden")).not.toBe(null);
  });

  test("the message adds no live region of its own", () => {
    for (const shown of [true, false]) expect(show(MessageView, { message: m(shown) }).querySelector("[aria-live]")).toBe(null);
  });
});

// Issue #5: Claude's messages are headed "Claude" and carry no "[claude]" prefix.
describe("Claude's messages", () => {
  test("a message of Claude is headed Claude, not Claude Code", () => {
    const root = show(MessageView, { message: { key: "1-1", author: "claude", heading: null, body: "x", format: "text", time: "2026-09-27T14:00:00.000Z", showTime: true } });
    expect(one(root, "header").textContent).toMatch(/^Claude(?! Code)/);
  });

  test("the panel shows Claude's prose from the reducer as Claude's article, without the prefix", () => {
    const time = "2026-09-27T14:00:00.000Z";
    const state = [
      { type: "hello", cwd: "/p", current: 1, incarnation: "a" },
      { type: "event", run: 1, seq: 0, time, event: { _tag: "Started", project: "/p", task: "t" } },
      { type: "event", run: 1, seq: 1, time, event: { _tag: "Notified", event: { _tag: "ClaudeSaid", text: "done" } } },
    ].reduce((s, m) => reduce(s, m as Parameters<typeof reduce>[1]), initialState);
    const root = show(ChatPanel, { title: "You and Interloq", messages: state.run?.left ?? [], empty: "none" });
    const article = one(root, "article[data-author=claude]");
    expect(article.classList.contains("claude")).toBe(true);
    expect(one(article, ".body").textContent?.trim()).toBe("done");
    expect(article.textContent).not.toContain("[claude]");
  });
});

describe("StartForm", () => {
  test("the description is the page's help text from src/prompts.ts, and says Claude (issue #5)", () => {
    const root = show(StartForm, { cwd: "/work", running: false, refused: null, chosen: null, onStart: () => undefined, onBrowse: () => undefined });
    const text = (one(root, ".help").textContent ?? "").replace(/\s+/g, " ").trim();
    expect(text).toContain("Claude writes a plan, Codex reviews it");
    expect(text).not.toContain("Claude Code");
    expect(text).toBe(prompts.START_FORM_DESCRIPTION.map((part) => part.text).join("").replace(/\s+/g, " ").trim());
  });

  test("Start is disabled while a field is empty or a run is active, and sends the project and the task", () => {
    const started: string[][] = [];
    const root = show(StartForm, { cwd: "/work", running: false, refused: null, chosen: null, onStart: (p: string, t: string) => void started.push([p, t]), onBrowse: () => undefined });
    const start = one(root, "button[name=start]") as HTMLButtonElement;
    expect((one(root, "input[name=project]") as HTMLInputElement).value).toBe("/work");
    expect(start.disabled).toBe(true);
    type(one(root, "textarea[name=task]") as HTMLTextAreaElement, "Write the docs");
    expect(start.disabled).toBe(false);
    start.click();
    flushSync();
    expect(started).toEqual([["/work", "Write the docs"]]);
    const busy = show(StartForm, { cwd: "/work", running: true, refused: null, chosen: null, onStart: () => undefined, onBrowse: () => undefined });
    type(one(busy, "textarea[name=task]") as HTMLTextAreaElement, "x");
    expect((one(busy, "button[name=start]") as HTMLButtonElement).disabled).toBe(true);
  });

  test("the form says what happens after Start (help and documentation)", () => {
    const root = show(StartForm, { cwd: "/work", running: false, refused: null, chosen: null, onStart: () => undefined, onBrowse: () => undefined });
    expect(root.textContent).toMatch(/Claude writes a plan, Codex reviews it/);
    expect(root.textContent).toMatch(/Stop task/);
  });

  // Finding 3 of docs/gui-review.md: remembering the directory is never a prerequisite for starting a task.
  const startsDespite = (breakStorage: () => () => void) => {
    const restore = breakStorage();
    try {
      const started: string[][] = [];
      const root = show(StartForm, { cwd: "/work", running: false, refused: null, chosen: null, onStart: (p: string, t: string) => void started.push([p, t]), onBrowse: () => undefined });
      expect((one(root, "input[name=project]") as HTMLInputElement).value).toBe("/work");
      type(one(root, "textarea[name=task]") as HTMLTextAreaElement, "Write the docs");
      (one(root, "button[name=start]") as HTMLButtonElement).click();
      flushSync();
      expect(started).toEqual([["/work", "Write the docs"]]);
    } finally {
      restore();
    }
  };
  const denied = () => new DOMException("access denied", "SecurityError");
  test("Start still starts when storing the directory throws, and a failing read falls back to the server's directory", () => {
    startsDespite(() => {
      const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw denied();
      });
      const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw denied();
      });
      return () => {
        set.mockRestore();
        get.mockRestore();
      };
    });
  });
  test("the form renders and Start starts when the localStorage getter itself throws", () => {
    startsDespite(() => {
      const original = Object.getOwnPropertyDescriptor(window, "localStorage");
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() {
          throw denied();
        },
      });
      return () => {
        if (original !== undefined) Object.defineProperty(window, "localStorage", original);
      };
    });
  });

  test("a refusal is shown as the field's error text", () => {
    const root = show(StartForm, { cwd: "/work", running: false, refused: "/work is not a git repository", chosen: null, onStart: () => undefined, onBrowse: () => undefined });
    expect(root.textContent).toMatch(/is not a git repository/);
  });

  test("offline, Start and Browse… are disabled, and the fields stay editable and keep their text", () => {
    const started: string[] = [];
    const root = show(StartForm, { cwd: "/work", running: false, refused: null, chosen: null, offline: true, onStart: () => void started.push("start"), onBrowse: () => void started.push("browse") });
    const task = one(root, "textarea[name=task]") as HTMLTextAreaElement;
    type(task, "Write the docs");
    expect(task.disabled).toBe(false);
    expect((one(root, "input[name=project]") as HTMLInputElement).disabled).toBe(false);
    expect((one(root, "button[name=start]") as HTMLButtonElement).disabled).toBe(true);
    expect((one(root, "button[name=browse]") as HTMLButtonElement).disabled).toBe(true);
    one(root, "form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    flushSync();
    expect(started).toEqual([]);
    expect(task.value).toBe("Write the docs");
  });
});

// Issue #12: the agent's options are cards in a group of their own, the fixed choices buttons below them.
const optionsGroup = (root: ParentNode) => root.querySelector<HTMLElement>(`[role=group][aria-label="${prompts.PROPOSED_ANSWERS_LABEL}"]`);
const cardsOf = (root: ParentNode): HTMLButtonElement[] => [...(optionsGroup(root)?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
/** An m3-svelte Card: its container and variant, without the size and icon classes only m3-svelte's Button sets. */
const isCard = (el: Element) =>
  el.classList.contains("m3-container") && el.classList.contains("outlined") && !el.classList.contains("s") && ![...el.classList].some((c) => c.startsWith("icon-"));
const paragraph = (n: number, topic: string) =>
  `${n}. ${topic}: ${"a sentence long enough to wrap over several lines of any window, with its reason and its consequences, ".repeat(3)}and its end ${n}.`;

describe("PromptWidget", () => {
  test("paragraph-length options are outlined cards with their full text, native buttons that send only the number (issue #12)", () => {
    const sent: string[] = [];
    const options = [1, 2, 3].map((n) => ({ label: paragraph(n, `Answer ${n}`), sends: String(n) }));
    expect(options.every((o) => o.label.length > 300)).toBe(true);
    const root = show(PromptWidget, { widget: widget(prompts.interviewMessagePrompt, options), onAnswer: (_p: number, t: string) => void sent.push(t) });
    const cards = cardsOf(root);
    expect(cards.map((c) => c.textContent?.trim())).toEqual(options.map((o) => o.label));
    for (const card of cards) {
      expect(card.tagName).toBe("BUTTON");
      expect(card.type).toBe("button");
      expect(isCard(card), `${card.className} is a card`).toBe(true);
      expect(card.classList.contains("filled") || card.classList.contains("tonal")).toBe(false);
    }
    cards[1].click();
    expect(sent).toEqual(["2"]);
    // The fixed choices stay buttons below: End interview the filled primary action, Quit outlined; no option among them.
    const fixed = [...root.querySelectorAll<HTMLButtonElement>(".choices button")];
    expect(fixed.map((b) => b.textContent?.trim())).toEqual(["End interview", "Quit"]);
    expect(fixed[0].classList.contains("filled")).toBe(true);
    expect(fixed[1].classList.contains("outlined")).toBe(true);
  });

  test("a relayed question's options are cards too, with Quit and the text field below (issue #12, Q4)", () => {
    const sent: string[] = [];
    const options = [{ label: "A", sends: "1" }, { label: "B", sends: "2" }, { label: paragraph(3, "C"), sends: "3" }];
    const root = show(PromptWidget, { widget: widget(prompts.optionOrTextPrompt, options), onAnswer: (_p: number, t: string) => void sent.push(t) });
    const cards = cardsOf(root);
    expect(cards.map((c) => c.textContent?.trim())).toEqual(options.map((o) => o.label));
    expect(cards.map((c) => isCard(c))).toEqual([true, true, true]);
    cards[2].click();
    expect(sent).toEqual(["3"]);
    const fixed = [...root.querySelectorAll<HTMLButtonElement>(".choices button")];
    expect(fixed.map((b) => `${b.textContent?.trim()}:${b.classList.contains("outlined")}`)).toEqual(["Quit:true"]);
    expect(root.querySelector("input[name=answer]")).not.toBe(null);
  });

  test("a prompt without options has no group of cards", () => {
    const root = show(PromptWidget, { widget: widget(prompts.decisionPrompt("issue A")), onAnswer: () => undefined });
    expect(optionsGroup(root)).toBe(null);
  });

  test("a choice sends its catalog text on one click; typed text is sent with Enter", () => {
    const sent: [number, string][] = [];
    const root = show(PromptWidget, { widget: widget(prompts.decisionPrompt("issue A")), onAnswer: (p: number, t: string) => void sent.push([p, t]) });
    const buttons = [...root.querySelectorAll(".choices button")].map((b) => b.textContent?.trim());
    expect(buttons).toEqual(["No decision", "Quit"]);
    (root.querySelectorAll(".choices button")[0] as HTMLButtonElement).click();
    const input = one(root, "input[name=answer]") as HTMLInputElement;
    type(input, "keep the rejection");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    flushSync();
    expect(sent).toEqual([[7, ""], [7, "keep the rejection"]]);
  });

  test("an interview's numbered answer sends its number; a permission prompt has no text field", () => {
    const sent: string[] = [];
    const root = show(PromptWidget, { widget: widget(prompts.interviewMessagePrompt, [{ label: "1. PostgreSQL", sends: "1" }, { label: "2. SQLite", sends: "2" }]), onAnswer: (_p: number, t: string) => void sent.push(t) });
    const two = [...cardsOf(root)].find((b) => b.textContent?.trim() === "2. SQLite") as HTMLButtonElement;
    two.click();
    expect(sent).toEqual(["2"]);
    expect(root.querySelector("textarea[name=answer]")).not.toBe(null);
    const permission = show(PromptWidget, { widget: widget(prompts.permissionPrompt), onAnswer: () => undefined });
    expect(permission.querySelector("[name=answer]")).toBe(null);
  });

  // Finding 6 of docs/gui-review.md: an input method's Enter is not an answer; a visible Send and a persistent label.
  const key = (el: Element, init: KeyboardEventInit) => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }));
    flushSync();
  };
  test("Enter while an input method is composing sends nothing, on the line field and the message field", () => {
    const sent: string[] = [];
    const line = show(PromptWidget, { widget: widget(prompts.decisionPrompt("issue A")), onAnswer: (_p: number, t: string) => void sent.push(t) });
    const input = one(line, "input[name=answer]") as HTMLInputElement;
    type(input, "unfinished composition");
    key(input, { isComposing: true });
    const message = show(PromptWidget, { widget: widget(prompts.interviewMessagePrompt), onAnswer: (_p: number, t: string) => void sent.push(t) });
    const area = one(message, "textarea[name=answer]") as HTMLTextAreaElement;
    type(area, "unfinished too");
    key(area, { isComposing: true });
    key(area, { shiftKey: true });
    expect(sent).toEqual([]);
    key(input, {});
    key(area, {});
    expect(sent).toEqual(["unfinished composition", "unfinished too"]);
  });

  test("a Send button sends the field's text and is disabled while the field is empty; the field keeps its label", () => {
    const sent: string[] = [];
    const root = show(PromptWidget, { widget: widget(prompts.decisionPrompt("issue A")), onAnswer: (_p: number, t: string) => void sent.push(t) });
    const send = one(root, "button[name=send]") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    type(one(root, "input[name=answer]") as HTMLInputElement, "keep it");
    expect(send.disabled).toBe(false);
    send.click();
    flushSync();
    expect(sent).toEqual(["keep it"]);
    expect(root.querySelector("label")?.textContent).toBe("Your answer");
    expect(root.querySelector(".hint")?.textContent).toBe(prompts.answerHint("line"));
    const message = show(PromptWidget, { widget: widget(prompts.interviewMessagePrompt), onAnswer: () => undefined });
    expect(message.querySelector("label")?.textContent).toBe("Your message");
  });

  // G-R1-1 of the defects' requirements: once the page has failed, answering stays possible and is refused by the
  // socket, and nothing typed is cleared.
  test("offline, the choices and Send stay enabled, and sending keeps the field's text; online it clears it", () => {
    const sent: string[] = [];
    const root = show(PromptWidget, { widget: widget(prompts.decisionPrompt("issue A")), offline: true, onAnswer: (_p: number, t: string) => void sent.push(t) });
    const input = one(root, "input[name=answer]") as HTMLInputElement;
    type(input, "typed offline");
    const send = one(root, "button[name=send]") as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    flushSync();
    expect(input.value).toBe("typed offline");
    send.click();
    flushSync();
    expect(input.value).toBe("typed offline");
    const choice = root.querySelectorAll(".choices button")[0] as HTMLButtonElement;
    expect(choice.disabled).toBe(false);
    choice.click();
    flushSync();
    expect(input.value).toBe("typed offline");
    expect(sent).toEqual(["typed offline", "typed offline", ""]);
    const online = show(PromptWidget, { widget: widget(prompts.decisionPrompt("issue A")), offline: false, onAnswer: () => undefined });
    const field = one(online, "input[name=answer]") as HTMLInputElement;
    type(field, "sent online");
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    flushSync();
    expect(field.value).toBe("");
  });

  test("without a pending prompt nothing can be sent", () => {
    const root = show(PromptWidget, { widget: null, onAnswer: () => undefined });
    expect(root.querySelector("button")).toBe(null);
  });
});

describe("TimelineRail", () => {
  test("phases in order with their state, and the rounds grouped under each review", () => {
    const root = show(TimelineRail, {
      busy: true,
      timeline: [
        { phase: { kind: "questions" }, label: "Question phase", state: "done", groups: [{ subject: "questions", heading: "Question review", rounds: [{ round: 1, limit: 5 }], done: true }] },
        { phase: { kind: "planning", n: 1 }, label: "Planning 1", state: "active", groups: [{ subject: { plan: 1 }, heading: "Planning phase 1", rounds: [{ round: 1, limit: 5 }, { round: 2, limit: 5 }], done: false }] },
      ],
    });
    const entries = [...root.querySelectorAll("[data-state]")].map((e) => `${e.getAttribute("data-state")}:${e.querySelector("[data-label]")?.textContent?.trim()}`);
    expect(entries).toEqual(["done:Question phase", "active:Planning 1"]);
    expect(root.textContent).toMatch(/round 2 of 5/);
    // A phase with one review loop does not repeat its name as a sub-heading.
    expect(root.textContent).not.toMatch(/Planning phase 1/);
    expect(root.textContent).not.toMatch(/Question review/);
    expect(root.querySelector("[data-busy]")).not.toBe(null);
  });
});

describe("DirectoryDialog", () => {
  test("lists the subdirectories, goes up and into a directory, and chooses", () => {
    const listed: string[] = [];
    const chosen: string[] = [];
    const root = show(DirectoryDialog, { open: true, listing: { path: "/work", parent: "/", dirs: ["a", "b"], error: null }, onList: (p: string) => void listed.push(p), onChoose: (p: string) => void chosen.push(p), onClose: () => undefined });
    const rows = [...root.querySelectorAll("[data-dir]")].map((e) => e.getAttribute("data-dir"));
    expect(rows).toEqual(["..", "a", "b"]);
    (one(root, "[data-dir=b]") as HTMLElement).click();
    (one(root, "[data-dir='..']") as HTMLElement).click();
    (one(root, "button[name=choose]") as HTMLButtonElement).click();
    expect(listed).toEqual(["/work/b", "/"]);
    expect(chosen).toEqual(["/work"]);
  });

  test("offline, the directories and Choose are disabled, and Cancel is not", () => {
    const root = show(DirectoryDialog, { open: true, listing: { path: "/work", parent: "/", dirs: ["a"], error: null }, offline: true, onList: () => undefined, onChoose: () => undefined, onClose: () => undefined });
    expect([...root.querySelectorAll<HTMLButtonElement>("[data-dir]")].map((b) => b.disabled)).toEqual([true, true]);
    expect((one(root, "button[name=choose]") as HTMLButtonElement).disabled).toBe(true);
    expect((one(root, "button[name=cancel]") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("TopBar", () => {
  test("Stop sends stop for the run on one click, and is disabled without a run in progress", () => {
    const stopped: number[] = [];
    const run = { ...emptyRun(3), project: "/p", task: "the task" };
    const root = show(TopBar, { run, connection: "open", onStop: (r: number) => void stopped.push(r) });
    const stop = one(root, "button[name=stop]") as HTMLButtonElement;
    expect(stop.textContent?.trim()).toBe("Stop task");
    stop.click();
    expect(stopped).toEqual([3]);
    expect(root.textContent).toMatch(/connected/);
    const idle = show(TopBar, { run: null, connection: "reconnecting", onStop: () => undefined });
    expect((one(idle, "button[name=stop]") as HTMLButtonElement).disabled).toBe(true);
    expect(idle.textContent).toMatch(/reconnecting/);
    const ended = show(TopBar, { run: { ...run, ended: 0 }, connection: "open", onStop: () => undefined });
    expect((one(ended, "button[name=stop]") as HTMLButtonElement).disabled).toBe(true);
  });

  test("a failed page: the chip reads disconnected and Stop is disabled", () => {
    const run = { ...emptyRun(3), project: "/p", task: "the task" };
    const root = show(TopBar, { run, connection: "failed", onStop: () => undefined });
    expect(one(root, "[role=status]").textContent?.trim()).toBe("disconnected");
    expect((one(root, "button[name=stop]") as HTMLButtonElement).disabled).toBe(true);
  });
});

// Finding 5 of docs/gui-review.md: the page mounted whole over a fake WebSocket; a draft does not survive its prompt.
describe("App and the draft", () => {
  class FakeWebSocket {
    static last: FakeWebSocket | null = null;
    static all: FakeWebSocket[] = [];
    sent: string[] = [];
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onclose: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    constructor(_url: string) {
      FakeWebSocket.last = this;
      FakeWebSocket.all.push(this);
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.onclose?.({});
    }
    receive(m: unknown) {
      this.onmessage?.({ data: JSON.stringify(m) });
      flushSync();
    }
    receiveRaw(text: string) {
      this.onmessage?.({ data: text });
      flushSync();
    }
  }
  const started = { _tag: "Started", project: "/p", task: "t" };
  const TIME = "2026-09-27T14:00:00.000Z";
  const stamp = (events: readonly unknown[]) => events.map((event) => ({ time: TIME, event }));
  const asked = (prompt: number) => ({ _tag: "Asked", prompt, ...promptOf(prompts.decisionPrompt(`issue ${prompt}`)) });
  const openPage = async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { default: App } = await import("./components/App.svelte");
    const root = show(App, {});
    const ws = FakeWebSocket.last!;
    ws.receive({ type: "hello", cwd: "/p", current: 1, incarnation: "a" });
    return { root, ws };
  };
  const field = (root: ParentNode) => one(root, "[name=answer]") as HTMLInputElement;
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    FakeWebSocket.all = [];
  });

  test("the right panel is titled Claude and Codex (issue #5)", async () => {
    const { root, ws } = await openPage();
    ws.receive({ type: "replay", runs: [{ id: 1, events: stamp([started]) }] });
    expect(root.querySelector('section[aria-label="Claude and Codex"]')).not.toBe(null);
  });

  test("another tab's answer withdraws the draft with a notice; the next prompt's field is empty", async () => {
    const { root, ws } = await openPage();
    ws.receive({ type: "replay", runs: [{ id: 1, events: stamp([started, asked(1)]) }] });
    type(field(root), "draft for question one");
    ws.receive({ type: "event", run: 1, seq: 2, time: TIME, event: { _tag: "Answered", prompt: 1, text: "" } });
    ws.receive({ type: "event", run: 1, seq: 3, time: TIME, event: asked(2) });
    expect(field(root).value).toBe("");
    expect(root.textContent).toContain(prompts.draftWithdrawnNotice("draft for question one"));
  });

  test("after a reconnection whose replay answered the prompt, the draft is withdrawn with a notice", async () => {
    const { root, ws } = await openPage();
    ws.receive({ type: "replay", runs: [{ id: 1, events: stamp([started, asked(1)]) }] });
    type(field(root), "draft for question one");
    ws.receive({ type: "hello", cwd: "/p", current: 1, incarnation: "a" });
    ws.receive({ type: "replay", runs: [{ id: 1, events: stamp([started, asked(1), { _tag: "Answered", prompt: 1, text: "" }, asked(2)]) }] });
    expect(field(root).value).toBe("");
    expect(root.textContent).toMatch(/your unsent text was discarded: «draft for question one»/);
  });

  // Defect B of docs/page-question-phase-defects.md: three frames in a row the page cannot read end in a failed page
  // that says so, refuses what it cannot send, and loses no typed text (Q5, G-R1-1, P1-R1-2).
  const failThreeTimes = () => {
    for (let i = 0; i < 3; i++) {
      FakeWebSocket.last!.receiveRaw("not json");
      vi.advanceTimersByTime(30_000);
      flushSync();
    }
  };
  const enter = (el: HTMLElement) => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    flushSync();
  };

  test("a failed page: the banner, Stop disabled, the prompt usable, the queued answer back in its field, a new one refused", async () => {
    vi.useFakeTimers();
    const { root, ws } = await openPage();
    ws.receive({ type: "replay", runs: [{ id: 1, events: stamp([started, asked(1)]) }] });
    ws.close();
    flushSync();
    type(field(root), "queued answer");
    enter(field(root));
    expect(field(root).value).toBe("");
    failThreeTimes();
    expect(one(root, ".failed[role=alert]").textContent).toContain(prompts.CONNECTION_FAILED_NOTICE);
    expect(one(root, "[role=status]").textContent?.trim()).toBe("disconnected");
    expect((one(root, "button[name=stop]") as HTMLButtonElement).disabled).toBe(true);
    expect((root.querySelectorAll(".choices button")[0] as HTMLButtonElement).disabled).toBe(false);
    expect(field(root).value).toBe("queued answer");
    expect(root.textContent).toContain(prompts.notSentNotice("answer", "disconnected"));
    type(field(root), "typed after the failure");
    enter(field(root));
    expect(field(root).value).toBe("typed after the failure");
    expect(FakeWebSocket.all.flatMap((s) => s.sent)).toEqual([]);
  });

  test("several actions discarded: the newer draft stays, and the answers are kept under Not sent until dismissed", async () => {
    vi.useFakeTimers();
    const { root, ws } = await openPage();
    ws.receive({ type: "replay", runs: [{ id: 1, events: stamp([started, asked(1)]) }] });
    ws.close();
    flushSync();
    type(field(root), "answer A");
    enter(field(root));
    type(field(root), "answer C");
    enter(field(root));
    (one(root, "button[name=stop]") as HTMLButtonElement).click();
    flushSync();
    type(field(root), "draft B");
    failThreeTimes();
    expect(field(root).value).toBe("draft B");
    const kept = () => [...root.querySelectorAll(".unsent li .unsent-text")].map((e) => e.textContent);
    expect(one(root, ".unsent").textContent).toContain(prompts.UNSENT_HEADING);
    expect(kept()).toEqual(["answer A", "answer C"]);
    expect(root.textContent).toContain(prompts.notSentNotice("stop", "disconnected"));
    enter(field(root));
    expect(root.textContent).toContain(prompts.notSentNotice("answer", "disconnected"));
    expect(kept()).toEqual(["answer A", "answer C"]);
    (root.querySelectorAll(".unsent button[name=dismiss]")[0] as HTMLButtonElement).click();
    flushSync();
    expect(kept()).toEqual(["answer C"]);
  });
});
