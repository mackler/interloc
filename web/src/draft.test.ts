import { describe, expect, test } from "vitest";
import * as prompts from "../../src/prompts.ts";
import type { RunEvent, ServerMessage } from "../../src/protocol.ts";
import { promptOf } from "../../src/userPrompts.ts";
import { type Draft, draftFor, pendingKey, reconcile } from "./draft.ts";
import { initialState, reduce, type ViewState } from "./state.ts";

// Finding 5 of docs/gui-review.md: a draft belongs to (incarnation, run, prompt).
const started: RunEvent = { _tag: "Started", project: "/p", task: "t", time: "x" };
const asked = (prompt: number): RunEvent => ({ _tag: "Asked", prompt, ...promptOf(prompts.decisionPrompt(`issue ${prompt}`)) });
const answered = (prompt: number): RunEvent => ({ _tag: "Answered", prompt, text: "" });
const hello = (incarnation = "a", current: number | null = 1): ServerMessage => ({ type: "hello", cwd: "/p", current, incarnation });
const fold = (messages: readonly ServerMessage[], from: ViewState = initialState): ViewState => messages.reduce(reduce, from);
const live = (events: readonly RunEvent[]): ViewState => fold([hello(), { type: "replay", runs: [] }, ...events.map((event, seq): ServerMessage => ({ type: "event", run: 1, seq, event }))]);
const draft: Draft = { key: { incarnation: "a", run: 1, prompt: 1 }, text: "my unsent answer" };

describe("draft", () => {
  test("the pending prompt's key, and the draft's text only for its own key", () => {
    const view = live([started, asked(1)]);
    expect(pendingKey(view)).toEqual({ incarnation: "a", run: 1, prompt: 1 });
    expect(draftFor(draft, pendingKey(view))).toBe("my unsent answer");
    expect(draftFor(draft, { incarnation: "a", run: 1, prompt: 2 })).toBe("");
    expect(draftFor(null, pendingKey(view))).toBe("");
  });

  test("a live answer from another tab withdraws the draft with a notice", () => {
    expect(reconcile(draft, live([started, asked(1), answered(1), asked(2)]))).toEqual({ draft: null, notice: prompts.draftWithdrawnNotice("my unsent answer") });
  });

  test("a replay after a reconnection in which the prompt was answered meanwhile withdraws the draft with a notice", () => {
    const view = fold([hello(), { type: "replay", runs: [{ id: 1, events: [started, asked(1), answered(1), asked(2)] }] }], live([started, asked(1)]));
    expect(reconcile(draft, view)).toEqual({ draft: null, notice: prompts.draftWithdrawnNotice("my unsent answer") });
  });

  test("a replay in which the same prompt is still pending keeps the draft", () => {
    const view = fold([hello(), { type: "replay", runs: [{ id: 1, events: [started, asked(1)] }] }], live([started, asked(1)]));
    expect(reconcile(draft, view)).toEqual({ draft, notice: null });
  });

  test("another incarnation of the server withdraws the draft with a notice; an empty draft goes quietly", () => {
    const view = fold([hello("b"), { type: "replay", runs: [{ id: 1, events: [started, asked(1)] }] }], live([started, asked(1)]));
    expect(reconcile(draft, view)).toEqual({ draft: null, notice: prompts.draftWithdrawnNotice("my unsent answer") });
    expect(reconcile({ ...draft, text: "" }, live([started, asked(1), answered(1)]))).toEqual({ draft: null, notice: null });
  });
});
