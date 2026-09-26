import fc from "fast-check";
import { describe, expect, test } from "vitest";
import * as prompts from "../../src/prompts.ts";
import type { RunEvent, ServerMessage } from "../../src/protocol.ts";
import type { UiEvent } from "../../src/uiEvents.ts";
import { promptOf } from "../../src/userPrompts.ts";
import { initialState, reduce, type ViewState } from "./state.ts";

// Plan step 4.2: the page's reducer.
const hello = (current: number | null = 1): ServerMessage => ({ type: "hello", cwd: "/p", current });
const started: RunEvent = { _tag: "Started", project: "/p", task: "the task", time: "t" };
const said = (text: string): RunEvent => ({ _tag: "Said", text });
const notified = (event: UiEvent): RunEvent => ({ _tag: "Notified", event });
const asked = (prompt: number, text: string): RunEvent => ({ _tag: "Asked", prompt, ...promptOf(text) });
/** The live messages of one run: hello, an empty replay, then the events with seq from 0. */
const live = (events: readonly RunEvent[], run = 1): ServerMessage[] => [hello(run), { type: "replay", runs: [] }, ...events.map((event, seq): ServerMessage => ({ type: "event", run, seq, event }))];
const fold = (messages: readonly ServerMessage[], from: ViewState = initialState): ViewState => messages.reduce(reduce, from);
const replayed = (events: readonly RunEvent[], run = 1, current: number | null = run): ViewState => fold([hello(current), { type: "replay", runs: [{ id: run, events }] }]);
const bodies = (s: ViewState) => s.run?.left.map((m) => `${m.author}:${m.body}`) ?? [];

describe("ordering and the panels", () => {
  test("program messages, a prompt and the user's answer appear in order; a blank say is dropped", () => {
    const s = fold(live([started, said("Planning phase 1 ..."), said("\n"), asked(1, prompts.decisionPrompt("question from Claude Code: Which?")), { _tag: "Answered", prompt: 1, text: "" }]));
    expect(bodies(s)).toEqual(["program:Planning phase 1 ...", "program:Decision on: question from Claude Code: Which?", "user:No decision"]);
    expect(s.run?.pending).toBe(null);
  });

  test("a pending prompt carries the catalog's choices; the numbered answers of the preceding interview turn come first", () => {
    const decision = fold(live([started, asked(1, prompts.decisionPrompt("x"))]));
    expect(decision.run?.pending?.choices.map((c) => c.label)).toEqual(["No decision", "Quit"]);
    const turn: UiEvent = { _tag: "InterviewTurn", heading: "Interview", message: "Which database?\n1. PostgreSQL\n2. SQLite", summary: null };
    const interview = fold(live([started, notified(turn), said("\nWhich database?\n1. PostgreSQL\n2. SQLite\n"), asked(1, prompts.interviewMessagePrompt)]));
    expect(interview.run?.pending?.choices.map((c) => `${c.label}=${c.sends}`)).toEqual(["1. PostgreSQL=1", "2. SQLite=2", "End interview=/done", "Quit=/quit"]);
    const question: UiEvent = { _tag: "QuestionAsked", question: "A or B?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] };
    const relayed = fold(live([started, notified(question), asked(1, prompts.optionOrTextPrompt)]));
    expect(relayed.run?.pending?.choices.map((c) => `${c.label}=${c.sends}`)).toEqual(["A=1", "B=2", "Quit=q"]);
  });

  test("an answer that is a choice shows the choice's label", () => {
    const s = fold(live([started, asked(1, prompts.permissionPrompt), { _tag: "Answered", prompt: 1, text: "y" }]));
    expect(bodies(s).at(-1)).toBe("user:Allow");
  });

  test("an interview turn and a proposed summary each appear once, live and after a replay", () => {
    const turn: UiEvent = { _tag: "InterviewTurn", heading: "Interview", message: "Hello", summary: null };
    const summary: UiEvent = { _tag: "InterviewTurn", heading: "Interview", message: "Done.", summary: "# R" };
    const events: RunEvent[] = [started, notified(turn), said("\nHello\n"), notified(summary), said("\nDone.\n"), said("Summary proposed by Claude Code:\n\n# R\n"), said("\nHello\n")];
    const expected = ["program:Hello", "program:Done.\n\n**Summary proposed by Claude Code:**\n\n# R", "program:\nHello\n"];
    expect(bodies(fold(live(events)))).toEqual(expected);
    expect(bodies(replayed(events))).toEqual(expected);
  });

  test("a plan write is one program message with its result text and questions, live and after a replay", () => {
    const events: RunEvent[] = [started, notified({ _tag: "PlanWritten", phase: 1, questions: ["Which?"], resultText: "I wrote the plan." })];
    for (const s of [fold(live(events)), replayed(events)]) {
      const m = s.run?.left.at(-1);
      expect(m?.format).toBe("markdown");
      expect(m?.body).toMatch(/planning phase 1/);
      expect(m?.body).toMatch(/I wrote the plan\./);
      expect(m?.body).toMatch(/- Which\?/);
    }
  });

  test("reviews and responses go to the right panel as Codex and Claude Code messages", () => {
    const review = { issues: [{ id: "A", severity: "major" as const, location: "l", problem: "p", evidence: "e" }] };
    const response = { dispositions: [{ id: "A", action: "accepted" as const, rationale: "r", duplicate_of: "", reverses: "" }], self_corrections: [], reviewer_feedback: "", questions_for_user: [] };
    const s = fold(live([started, notified({ _tag: "ReviewReceived", subject: { plan: 1 }, round: 2, review, counted: 1 }), notified({ _tag: "ResponseReceived", subject: { plan: 1 }, round: 2, response, resultText: "" })]));
    expect(s.run?.right.map((m) => [m.author, m.heading])).toEqual([["codex", "Planning phase 1, round 2"], ["claude", "Planning phase 1, round 2"]]);
    expect(s.run?.right[0].body).toMatch(/\*\*\[A\]\*\*/);
    // The author is the message's; the body does not repeat it (aesthetic and minimalist design).
    expect(s.run?.right.map((m) => m.body)).not.toContainEqual(expect.stringMatching(/^### /));
    const none = fold(live([started, notified({ _tag: "ReviewReceived", subject: { plan: 1 }, round: 3, review: { issues: [] }, counted: 0 })]));
    expect(none.run?.right[0].body).toBe("No issue: the review has converged.");
  });
});

// Plan step 4.7 (the review against the heuristics): the page states a prompt without the terminal's key
// conventions, which the buttons replace [match between the system and the real world].
test("every prompt is shown in the page's words, without the terminal's key conventions", () => {
  const texts = [prompts.decisionPrompt("issue A"), prompts.limitPrompt(5, "proceed to execution"), prompts.limitNoProceedPrompt(5), prompts.execInputPrompt, prompts.optionOrTextPrompt, prompts.permissionPrompt, prompts.interviewMessagePrompt, prompts.confirmSummaryPrompt, prompts.startOrTalkPrompt];
  for (const text of texts) {
    const body = fold(live([started, asked(1, text)])).run?.left.at(-1)?.body ?? "";
    expect(body, text).not.toMatch(/>\s*$|\bq = quit|Enter =|= stop|p = /);
    expect(body.trim(), text).not.toBe("");
  }
  expect(fold(live([started, asked(1, prompts.limitPrompt(5, "proceed to execution"))])).run?.left.at(-1)?.body).toMatch(/5 rounds completed without convergence/);
  expect(fold(live([started, asked(1, "Something new > ")])).run?.left.at(-1)?.body).toBe("Something new");
});

describe("activity and timeline", () => {
  test("the activity line shows the last agent event and is cleared at the end of a phase", () => {
    const s1 = fold(live([started, notified({ _tag: "AgentCallStarted", agent: "codex", purpose: "review" }), notified({ _tag: "ToolUsed", agent: "codex", tool: "command", target: "git diff" })]));
    expect(s1.run?.activity).toBe("Codex — review — command: git diff");
    expect(s1.run?.busy).toBe(true);
    const s2 = fold([{ type: "event", run: 1, seq: 3, event: notified({ _tag: "PhaseEnded", phase: { kind: "planning", n: 1 }, result: "converged" }) }], s1);
    expect(s2.run?.activity).toBe("");
  });

  test("the question phase stays active through its review loops until PhaseEnded; each loop has its own group; replay agrees", () => {
    const q = { kind: "questions" as const };
    const events: RunEvent[] = [
      started,
      notified({ _tag: "PhaseBegan", phase: q }),
      notified({ _tag: "RoundBegan", subject: "questions", round: 1, limit: 5 }),
      notified({ _tag: "LoopFinished", subject: "questions", result: "converged" }),
      notified({ _tag: "InterviewTurn", heading: "Interview", message: "Hi", summary: null }),
      notified({ _tag: "RoundBegan", subject: "requirements", round: 1, limit: 5 }),
    ];
    const during = fold(live(events));
    const entry = during.run?.timeline[0];
    expect(entry?.state).toBe("active");
    expect(entry?.groups.map((g) => [g.heading, g.done])).toEqual([["Question review", true], ["Requirements review", false]]);
    const after = fold(live([...events, notified({ _tag: "LoopFinished", subject: "requirements", result: "converged" }), notified({ _tag: "PhaseEnded", phase: q, result: "converged" })]));
    expect(after.run?.timeline[0].state).toBe("done");
    expect(replayed(events).run?.timeline).toEqual(during.run?.timeline);
  });

  test("phases appear in order with their rounds; an interrupted run stops the active phase", () => {
    const s = fold(live([started, notified({ _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } }), notified({ _tag: "RoundBegan", subject: { plan: 1 }, round: 1, limit: 5 }), notified({ _tag: "RoundBegan", subject: { plan: 1 }, round: 2, limit: 5 }), { _tag: "Ended", code: 130 }]));
    expect(s.run?.timeline.map((e) => [e.label, e.state])).toEqual([["Planning 1", "stopped"]]);
    expect(s.run?.timeline[0].groups[0].rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(s.run?.ended).toBe(130);
  });
});

describe("runs, replay and gaps", () => {
  test("a seq that does not follow sets the reconnect flag; a new run's Started at seq 0 after Ended is not a gap", () => {
    const one = fold(live([started, { _tag: "Ended", code: 0 }]));
    expect(one.needsReconnect).toBe(false);
    const two = fold([{ type: "event", run: 2, seq: 0, event: started }], one);
    expect(two.needsReconnect).toBe(false);
    expect([two.run?.id, two.last?.id]).toEqual([2, 1]);
    const gap = fold([{ type: "event", run: 2, seq: 5, event: said("x") }], two);
    expect(gap.needsReconnect).toBe(true);
    const badStart = fold([{ type: "event", run: 3, seq: 4, event: started }], two);
    expect(badStart.needsReconnect).toBe(true);
  });

  test("a refusal becomes a notice; a listing is kept", () => {
    const s = fold([hello(null), { type: "refused", reason: "a run is in progress" }, { type: "listing", path: "/p", parent: "/", dirs: ["a"], error: null }]);
    expect(s.notices).toEqual(["a run is in progress"]);
    expect(s.listing?.dirs).toEqual(["a"]);
    expect(s.connection).toBe("open");
    expect(s.cwd).toBe("/p");
  });

  const tagged = <T extends RunEvent["_tag"]>(tag: T) => fc.constant(tag);
  const eventArb: fc.Arbitrary<RunEvent> = fc.oneof(
    fc.string({ maxLength: 8 }).map(said),
    tagged("Asked").chain(() => fc.constantFrom(prompts.permissionPrompt, prompts.interviewMessagePrompt, prompts.decisionPrompt("x")).map((t) => asked(1, t))),
    fc.constantFrom("", "y", "2").map((text): RunEvent => ({ _tag: "Answered", prompt: 1, text })),
    fc.constantFrom<UiEvent>(
      { _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } },
      { _tag: "RoundBegan", subject: { plan: 1 }, round: 1, limit: 5 },
      { _tag: "LoopFinished", subject: { plan: 1 }, result: "converged" },
      { _tag: "PhaseEnded", phase: { kind: "planning", n: 1 }, result: "converged" },
      { _tag: "InterviewTurn", heading: "Interview", message: "Hi", summary: null },
      { _tag: "AgentCallStarted", agent: "claude", purpose: "planning" },
      { _tag: "ToolUsed", agent: "claude", tool: "Read", target: "a" },
    ).map(notified),
    fc.constant(said("\nHi\n")),
  );
  test("property: the replay of two runs equals their incremental folding", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 12 }), fc.array(eventArb, { maxLength: 12 }), (a, b) => {
        const first: RunEvent[] = [started, ...a, { _tag: "Ended", code: 0 }];
        const second: RunEvent[] = [started, ...b];
        const incremental = fold([hello(null), { type: "replay", runs: [] }, ...first.map((event, seq): ServerMessage => ({ type: "event", run: 1, seq, event })), ...second.map((event, seq): ServerMessage => ({ type: "event", run: 2, seq, event }))]);
        const replay = fold([hello(2), { type: "replay", runs: [{ id: 1, events: first }, { id: 2, events: second }] }]);
        expect(replay.run).toEqual(incremental.run);
        expect(replay.last).toEqual(incremental.last);
        expect(incremental.needsReconnect).toBe(false);
      }),
    );
  });
});
