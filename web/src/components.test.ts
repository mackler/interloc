import { type Component, flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";
import * as prompts from "../../src/prompts.ts";
import { promptOf } from "../../src/userPrompts.ts";
import DirectoryDialog from "./components/DirectoryDialog.svelte";
import PromptWidget from "./components/PromptWidget.svelte";
import StartForm from "./components/StartForm.svelte";
import TimelineRail from "./components/TimelineRail.svelte";
import TopBar from "./components/TopBar.svelte";
import { emptyRun, type Widget } from "./state.ts";

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
const widget = (text: string, extra: Widget["choices"] = []): Widget => {
  const asked = { _tag: "Asked" as const, prompt: 7, ...promptOf(text) };
  return { asked, choices: [...extra, ...asked.choices] };
};

describe("StartForm", () => {
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
    expect(root.textContent).toMatch(/Claude Code writes a plan, Codex reviews it/);
    expect(root.textContent).toMatch(/Stop task/);
  });

  test("a refusal is shown as the field's error text", () => {
    const root = show(StartForm, { cwd: "/work", running: false, refused: "/work is not a git repository", chosen: null, onStart: () => undefined, onBrowse: () => undefined });
    expect(root.textContent).toMatch(/is not a git repository/);
  });
});

describe("PromptWidget", () => {
  test("a choice sends its catalog text on one click; typed text is sent with Enter", () => {
    const sent: [number, string][] = [];
    const root = show(PromptWidget, { widget: widget(prompts.decisionPrompt("issue A")), onAnswer: (p: number, t: string) => void sent.push([p, t]) });
    const buttons = [...root.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(buttons).toEqual(["No decision", "Quit"]);
    (root.querySelectorAll("button")[0] as HTMLButtonElement).click();
    const input = one(root, "input[name=answer]") as HTMLInputElement;
    type(input, "keep the rejection");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    flushSync();
    expect(sent).toEqual([[7, ""], [7, "keep the rejection"]]);
  });

  test("an interview's numbered answer sends its number; a permission prompt has no text field", () => {
    const sent: string[] = [];
    const root = show(PromptWidget, { widget: widget(prompts.interviewMessagePrompt, [{ label: "1. PostgreSQL", sends: "1" }, { label: "2. SQLite", sends: "2" }]), onAnswer: (_p: number, t: string) => void sent.push(t) });
    const two = [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "2. SQLite") as HTMLButtonElement;
    two.click();
    expect(sent).toEqual(["2"]);
    expect(root.querySelector("textarea[name=answer]")).not.toBe(null);
    const permission = show(PromptWidget, { widget: widget(prompts.permissionPrompt), onAnswer: () => undefined });
    expect(permission.querySelector("[name=answer]")).toBe(null);
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
});
