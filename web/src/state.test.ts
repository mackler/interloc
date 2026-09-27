import fc from "fast-check";
import { describe, expect, test } from "vitest";
import * as prompts from "../../src/prompts.ts";
import { decodeServer, type RunEvent, type ServerMessage, type Stamped } from "../../src/protocol.ts";
import type { UiEvent } from "../../src/uiEvents.ts";
import { promptOf } from "../../src/userPrompts.ts";
import { dismissUnsent, initialState, keepUnsent, protocolError, reduce, showsTime, type ViewState } from "./state.ts";

// Plan step 4.2: the page's reducer.
const hello = (current: number | null = 1): ServerMessage => ({ type: "hello", cwd: "/p", current, incarnation: "a" });
const started: RunEvent = { _tag: "Started", project: "/p", task: "the task" };
const said = (text: string): RunEvent => ({ _tag: "Said", text });
const notified = (event: UiEvent): RunEvent => ({ _tag: "Notified", event });
const asked = (prompt: number, text: string): RunEvent => ({ _tag: "Asked", prompt, ...promptOf(text) });
/** The time of publication of an event: by default one second per seq from 14:00:00 UTC; `times` gives it in seconds. */
const BASE = Date.UTC(2026, 8, 27, 14, 0, 0);
const at = (seconds: number): string => new Date(BASE + seconds * 1000).toISOString();
const stamp = (events: readonly RunEvent[], times?: readonly number[]): Stamped[] => events.map((event, seq) => ({ time: at(times?.[seq] ?? seq), event }));
/** The live messages of one run: hello, an empty replay, then the events with seq from 0. */
const live = (events: readonly RunEvent[], run = 1, times?: readonly number[]): ServerMessage[] => [hello(run), { type: "replay", runs: [] }, ...stamp(events, times).map(({ time, event }, seq): ServerMessage => ({ type: "event", run, seq, time, event }))];
const fold = (messages: readonly ServerMessage[], from: ViewState = initialState): ViewState => messages.reduce(reduce, from);
const replayed = (events: readonly RunEvent[], run = 1, current: number | null = run, times?: readonly number[]): ViewState => fold([hello(current), { type: "replay", runs: [{ id: run, events: stamp(events, times) }] }]);
const bodies = (s: ViewState) => s.run?.left.map((m) => `${m.author}:${m.body}`) ?? [];

describe("ordering and the panels", () => {
  test("program messages, a prompt and the user's answer appear in order; a blank say is dropped", () => {
    const s = fold(live([started, said("Planning phase 1 ..."), said("\n"), asked(1, prompts.decisionPrompt("question from Claude Code: Which?")), { _tag: "Answered", prompt: 1, text: "" }]));
    expect(bodies(s)).toEqual(["program:Planning phase 1 ...", "program:Decision on: question from Claude Code: Which?", "user:No decision"]);
    expect(s.run?.pending).toBe(null);
  });

  test("a pending prompt carries the catalog's choices; the agent's options (interview answers, relayed options) are apart (issue #12)", () => {
    const decision = fold(live([started, asked(1, prompts.decisionPrompt("x"))]));
    expect(decision.run?.pending?.choices.map((c) => c.label)).toEqual(["No decision", "Quit"]);
    expect(decision.run?.pending?.options).toEqual([]);
    const turn: UiEvent = { _tag: "InterviewTurn", heading: "Interview", message: "Which database?\n1. PostgreSQL\n2. SQLite", summary: null };
    const interview = fold(live([started, notified(turn), said("\nWhich database?\n1. PostgreSQL\n2. SQLite\n"), asked(1, prompts.interviewMessagePrompt)]));
    expect(interview.run?.pending?.options.map((c) => `${c.label}=${c.sends}`)).toEqual(["1. PostgreSQL=1", "2. SQLite=2"]);
    expect(interview.run?.pending?.choices.map((c) => `${c.label}=${c.sends}`)).toEqual(["End interview=/done", "Quit=/quit"]);
    const question: UiEvent = { _tag: "QuestionAsked", question: "A or B?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] };
    const relayed = fold(live([started, notified(question), asked(1, prompts.optionOrTextPrompt)]));
    expect(relayed.run?.pending?.options.map((c) => `${c.label}=${c.sends}`)).toEqual(["A=1", "B=2"]);
    expect(relayed.run?.pending?.choices.map((c) => `${c.label}=${c.sends}`)).toEqual(["Quit=q"]);
  });

  test("an answer to an interview shows the full line of the chosen option, or the fixed choice's label (issue #12, Q2)", () => {
    const turn: UiEvent = { _tag: "InterviewTurn", heading: "Interview", message: "Which database?\n1. PostgreSQL\n2. SQLite", summary: null };
    const answered = (text: string) => fold(live([started, notified(turn), asked(1, prompts.interviewMessagePrompt), { _tag: "Answered", prompt: 1, text }]));
    expect(bodies(answered("2")).at(-1)).toBe("user:2. SQLite");
    expect(bodies(answered("/done")).at(-1)).toBe("user:End interview");
  });

  test("an answer that is a choice shows the choice's label", () => {
    const s = fold(live([started, asked(1, prompts.permissionPrompt), { _tag: "Answered", prompt: 1, text: "y" }]));
    expect(bodies(s).at(-1)).toBe("user:Allow");
  });

  test("an interview turn and a proposed summary each appear once, live and after a replay", () => {
    const turn: UiEvent = { _tag: "InterviewTurn", heading: "Interview", message: "Hello", summary: null };
    const summary: UiEvent = { _tag: "InterviewTurn", heading: "Interview", message: "Done.", summary: "# R" };
    const events: RunEvent[] = [started, notified(turn), said("\nHello\n"), notified(summary), said("\nDone.\n"), said("Summary proposed by Claude Code:\n\n# R\n"), said("\nHello\n")];
    const expected = ["claude:Hello", "claude:Done.\n\n**Summary proposed by Claude:**\n\n# R", "program:\nHello\n"];
    expect(bodies(fold(live(events)))).toEqual(expected);
    expect(bodies(replayed(events))).toEqual(expected);
  });

  test("a plan write is one program message with its result text and questions, live and after a replay", () => {
    const events: RunEvent[] = [started, notified({ _tag: "PlanWritten", phase: 1, questions: ["Which?"], resultText: "I wrote the plan." })];
    for (const s of [fold(live(events)), replayed(events)]) {
      const m = s.run?.left.at(-1);
      expect(m?.format).toBe("markdown");
      expect(m?.author).toBe("program");
      expect(m?.body).toMatch(/^\*\*Claude wrote the plan \(planning phase 1\)\.\*\*/);
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

// Issue #5: what Claude Code writes is attributed to Claude, as data; the page names it "Claude".
describe("who speaks in the left panel", () => {
  const claudeSaid = notified({ _tag: "ClaudeSaid", text: "done" });

  test("Claude's prose is one message of Claude, without a prefix, live and after a replay", () => {
    for (const s of [fold(live([started, claudeSaid])), replayed([started, claudeSaid])]) {
      expect(s.run?.left.map((m) => [m.author, m.body])).toEqual([["claude", "done"]]);
    }
  });

  test("an interview turn and its proposed summary are Claude's; a plan write stays Interloq's", () => {
    const turn = notified({ _tag: "InterviewTurn", heading: "Interview", message: "Hi", summary: null });
    const summary = notified({ _tag: "InterviewTurn", heading: "Interview", message: "Done.", summary: "# R" });
    const plan = notified({ _tag: "PlanWritten", phase: 1, questions: [], resultText: "" });
    for (const s of [fold(live([started, turn, summary, plan])), replayed([started, turn, summary, plan])]) {
      expect(s.run?.left.map((m) => m.author)).toEqual(["claude", "claude", "program"]);
    }
  });

  test("the activity line and the page's prompts say Claude", () => {
    const s = fold(live([started, notified({ _tag: "AgentCallStarted", agent: "claude", purpose: "planning" })]));
    expect(s.run?.activity).toBe("Claude — planning");
    const tool = fold(live([started, notified({ _tag: "ToolUsed", agent: "claude", tool: "Read", target: "x" })]));
    expect(tool.run?.activity).toBe("Claude — Read: x");
    expect(prompts.pagePromptText("execInput", prompts.execInputPrompt)).toBe("Your input for Claude");
    expect(prompts.pagePromptText("startOrTalk", prompts.startOrTalkPrompt)).toBe("Claude and Codex agree that no question is needed. Start planning, or write a message to open a conversation with Claude.");
  });
});

// Issue #7: the left panel renders Markdown where Claude writes and where the user answers; Interloq's own texts stay plain.
describe("Markdown in the left panel", () => {
  const question: UiEvent = { _tag: "QuestionAsked", question: "A or **B**?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] };
  const questionLines = [said("\nQuestion from Claude Code: A or **B**?"), said("  1. A - a"), said("  2. B - b")];
  const formats = (s: ViewState) => s.run?.left.map((m) => `${m.author}:${m.format}`) ?? [];

  test("Claude's prose is Markdown", () => {
    for (const s of [fold(live([started, notified({ _tag: "ClaudeSaid", text: "**done**" })])), replayed([started, notified({ _tag: "ClaudeSaid", text: "**done**" })])]) {
      expect(formats(s)).toEqual(["claude:markdown"]);
    }
  });

  test("a relayed question is one Markdown message of Claude with its options; its terminal lines are absorbed", () => {
    const events: RunEvent[] = [started, notified(question), ...questionLines, asked(1, prompts.optionOrTextPrompt)];
    for (const s of [fold(live(events)), replayed(events)]) {
      expect(s.run?.left.map((m) => [m.author, m.format, m.body])).toEqual([
        ["claude", "markdown", "A or **B**?\n\n1. **A** — a\n2. **B** — b"],
        ["program", "text", prompts.pagePromptText("optionOrText", prompts.optionOrTextPrompt)],
      ]);
      expect(s.run?.pending?.options.map((c) => c.label)).toEqual(["A", "B"]);
    }
  });

  test("only the lines that follow the question directly are absorbed", () => {
    const s = fold(live([started, notified(question), ...questionLines, said("  1. A - a")]));
    expect(bodies(s)).toEqual(["claude:A or **B**?\n\n1. **A** — a\n2. **B** — b", "program:  1. A - a"]);
  });

  test("the user's answers are Markdown, typed or chosen", () => {
    const typed = [started, asked(1, prompts.interviewMessagePrompt), { _tag: "Answered", prompt: 1, text: "use **x**" } as RunEvent];
    const chosen = [started, asked(1, prompts.permissionPrompt), { _tag: "Answered", prompt: 1, text: "y" } as RunEvent];
    for (const s of [fold(live(typed)), replayed(typed), fold(live(chosen)), replayed(chosen)]) {
      expect(s.run?.left.at(-1)?.format).toBe("markdown");
    }
  });

  test("Interloq's lines, prompts and interview help stay plain; plan writes and interview turns stay Markdown", () => {
    const events: RunEvent[] = [
      started,
      said("a_b"),
      notified({ _tag: "InterviewOpened", heading: "Interview" }),
      notified({ _tag: "InterviewTurn", heading: "Interview", message: "Hi", summary: null }),
      notified({ _tag: "PlanWritten", phase: 1, questions: [], resultText: "" }),
      asked(1, prompts.decisionPrompt("x")),
    ];
    expect(formats(fold(live(events)))).toEqual(["program:text", "program:text", "claude:markdown", "program:markdown", "program:text"]);
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
    const s2 = fold([{ type: "event", run: 1, seq: 3, time: at(3), event: notified({ _tag: "PhaseEnded", phase: { kind: "planning", n: 1 }, result: "converged" }) }], s1);
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
    const two = fold([{ type: "event", run: 2, seq: 0, time: at(0), event: started }], one);
    expect(two.needsReconnect).toBe(false);
    expect([two.run?.id, two.last?.id]).toEqual([2, 1]);
    const gap = fold([{ type: "event", run: 2, seq: 5, time: at(5), event: said("x") }], two);
    expect(gap.needsReconnect).toBe(true);
    const badStart = fold([{ type: "event", run: 3, seq: 4, time: at(4), event: started }], two);
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
    fc.constant(notified({ _tag: "ReviewReceived", subject: { plan: 1 }, round: 1, review: { issues: [] }, counted: 0 })),
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
  // Issue #1: each event with a time, a gap of 0 to 300 s after the one before, so that the grouping of both panels is
  // covered by the property too.
  const timed = (events: readonly RunEvent[], gaps: readonly number[]): Stamped[] =>
    events.map((event, i) => ({ time: at(gaps.slice(0, i + 1).reduce((sum, g) => sum + g, 0)), event }));
  const gapsArb = fc.array(fc.nat({ max: 300 }), { minLength: 14, maxLength: 14 });
  test("property: the replay of two runs equals their incremental folding", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 12 }), fc.array(eventArb, { maxLength: 12 }), gapsArb, gapsArb, (a, b, gapsA, gapsB) => {
        const first = timed([started, ...a, { _tag: "Ended", code: 0 }], gapsA);
        const second = timed([started, ...b], gapsB);
        const incremental = fold([hello(null), { type: "replay", runs: [] }, ...first.map(({ time, event }, seq): ServerMessage => ({ type: "event", run: 1, seq, time, event })), ...second.map(({ time, event }, seq): ServerMessage => ({ type: "event", run: 2, seq, time, event }))]);
        const replay = fold([hello(2), { type: "replay", runs: [{ id: 1, events: first }, { id: 2, events: second }] }]);
        expect(replay.run).toEqual(incremental.run);
        expect(replay.last).toEqual(incremental.last);
        expect(incremental.needsReconnect).toBe(false);
      }),
    );
  });
});

// Finding 12 of docs/gui-review.md: a hello from another incarnation clears the view of the earlier server's runs.
describe("a server restart", () => {
  test("a hello with a new incarnation clears the old run's view; the same incarnation keeps it", () => {
    const withRun = reduce(reduce(initialState, { type: "hello", cwd: "/w", current: 3, incarnation: "a" }), { type: "replay", runs: [{ id: 3, events: [{ time: at(0), event: { _tag: "Started", project: "/p", task: "t" } }] }] });
    expect(withRun.run?.id).toBe(3);
    expect(withRun.incarnation).toBe("a");
    expect(reduce(withRun, { type: "hello", cwd: "/w", current: 3, incarnation: "a" }).run?.id).toBe(3);
    const restarted = reduce(withRun, { type: "hello", cwd: "/w", current: null, incarnation: "b" });
    expect([restarted.run, restarted.last, restarted.incarnation]).toEqual([null, null, "b"]);
    const next = reduce(restarted, { type: "event", run: 1, seq: 0, time: at(0), event: { _tag: "Started", project: "/p", task: "u" } });
    expect(next.run?.id).toBe(1);
  });
});

// Finding 15 of docs/gui-review.md: the server tells the page that it is ending.
describe("the server closing", () => {
  test("closing sets the connection to reconnecting and says so", () => {
    const next = reduce(reduce(initialState, hello()), { type: "closing" });
    expect(next.connection).toBe("reconnecting");
    expect(next.notices.at(-1)).toBe(prompts.SERVER_CLOSED_NOTICE);
  });
});

// Finding 5 of docs/gui-review.md: the view keeps the prompts that were answered, live and after a replay alike.
describe("answered prompts", () => {
  test("answered lists the prompts of the Answered events in order, equal between the live fold and the replay", () => {
    const events: RunEvent[] = [started, asked(1, prompts.decisionPrompt("x")), { _tag: "Answered", prompt: 1, text: "" }, asked(2, prompts.decisionPrompt("y")), { _tag: "Answered", prompt: 2, text: "a" }, asked(3, prompts.decisionPrompt("z"))];
    const liveRun = fold(live(events)).run;
    expect(liveRun?.answered).toEqual([1, 2]);
    expect(replayed(events).run?.answered).toEqual(liveRun?.answered);
  });
});

// Finding 8 of docs/gui-review.md: the page renders the interview's help without the terminal's """ convention.
describe("the interview's opening help", () => {
  test("the page message names /done, /quit and Shift+Enter, and has no triple quotes", () => {
    const s = fold(live([started, notified({ _tag: "InterviewOpened", heading: "Interview" })]));
    const body = s.run?.left.at(-1)?.body ?? "";
    expect(body).toBe(prompts.interviewHelp("Interview", "page"));
    expect(body).toMatch(/Shift\+Enter/);
    expect(body).toMatch(/\/done/);
    expect(body).not.toMatch(/"""/);
  });
});

// Defect B of docs/page-question-phase-defects.md: one notice per run of frames the page could not read (Q2), a failed
// page that stays failed, and the answers not sent kept apart from the notices (P1-R1-2).
describe("a frame the page could not read", () => {
  test("the first of a run adds the notice with its reason; the second and third add none", () => {
    const s = [1, 2, 3].reduce((acc, n) => protocolError(acc, `reason ${n}`, n), fold([hello()]));
    expect(s.notices).toEqual([prompts.protocolErrorNotice("reason 1")]);
    const long = protocolError(initialState, "z".repeat(500), 1);
    expect(long.notices[0].endsWith(`${"z".repeat(200)}…`)).toBe(true);
  });

  test("the server's closing does not turn a failed page into a reconnecting one", () => {
    const next = reduce({ ...fold([hello()]), connection: "failed" }, { type: "closing" });
    expect(next.connection).toBe("failed");
  });

  test("the answers not sent are kept in order, and one is dismissed alone", () => {
    const s = keepUnsent(keepUnsent(initialState, "A"), "C");
    expect(s.unsent).toEqual(["A", "C"]);
    expect(dismissUnsent(s, 0).unsent).toEqual(["C"]);
    expect(dismissUnsent(s, 1).unsent).toEqual(["A"]);
    expect(initialState.unsent).toEqual([]);
  });
});

// The scenario whose absence let defect A of docs/page-question-phase-defects.md through: a replay, as the server sends
// it, of a question phase with a review, Claude Code's response with the amended list, and the interview's first turn.
describe("a replay of a question phase", () => {
  test("decoded as the socket decodes it, it yields both panels and the pending interview prompt", () => {
    const events: RunEvent[] = [
      started,
      notified({ _tag: "PhaseBegan", phase: { kind: "questions" } }),
      notified({ _tag: "RoundBegan", subject: "questions", round: 1, limit: 5 }),
      notified({ _tag: "ReviewReceived", subject: "questions", round: 1, review: { issues: [{ id: "Q-R1-1", severity: "major", location: "Q1", problem: "The list does not ask for the database.", evidence: "e" }] }, counted: 1 }),
      notified({
        _tag: "ResponseReceived",
        subject: "questions",
        round: 1,
        response: {
          dispositions: [{ id: "Q-R1-1", action: "accepted", rationale: "Added the database question.", duplicate_of: "", reverses: "" }],
          self_corrections: [],
          reviewer_feedback: "",
          questions_for_user: [],
          questions: [{ id: "Q1", question: "Which database?", reason: "r", proposed_answers: [{ label: "PostgreSQL", description: "p" }, { label: "SQLite", description: "s" }], default_answer: "PostgreSQL" }],
        },
        resultText: "",
      }),
      notified({ _tag: "LoopFinished", subject: "questions", result: "converged" }),
      notified({ _tag: "InterviewOpened", heading: "Interview" }),
      notified({ _tag: "InterviewTurn", heading: "Interview", message: "Which database should the service use?\n1. PostgreSQL\n2. SQLite", summary: null }),
      said("\nWhich database should the service use?\n1. PostgreSQL\n2. SQLite\n"),
      asked(1, prompts.interviewMessagePrompt),
    ];
    const frames = [JSON.stringify(hello()), JSON.stringify({ type: "replay", runs: [{ id: 1, events: stamp(events) }] })];
    const messages = frames.map((f) => {
      const d = decodeServer(f);
      if (d._tag !== "Success") throw new Error(`not decoded: ${d.failure}`);
      return d.success;
    });
    const s = fold(messages);
    const right = s.run?.right.map((m) => `${m.author}:${m.body}`) ?? [];
    expect(right.length).toBe(2);
    expect(right[0]).toMatch(/^codex:.*The list does not ask for the database\./s);
    expect(right[1]).toMatch(/^claude:.*\[Q-R1-1\]\*\* accepted: Added the database question\./s);
    expect(bodies(s).slice(0, 2)).toEqual([`program:${prompts.interviewHelp("Interview", "page")}`, "claude:Which database should the service use?\n1. PostgreSQL\n2. SQLite"]);
    expect(s.run?.pending?.asked.kind).toBe("interviewMessage");
    expect(s.run?.pending?.options.map((c) => `${c.label}=${c.sends}`)).toEqual(["1. PostgreSQL=1", "2. SQLite=2"]);
    expect(s.run?.pending?.choices.map((c) => `${c.label}=${c.sends}`)).toEqual(["End interview=/done", "Quit=/quit"]);
  });
});

// Issue #1: each message carries the time its event was published; a time is shown when the author changes or more
// than 2 minutes lie between a message and the one before it in the same panel (decision Q3).
describe("the time of a message", () => {
  const review = notified({ _tag: "ReviewReceived", subject: { plan: 1 }, round: 1, review: { issues: [] }, counted: 0 });
  const shown = (s: ViewState, panel: "left" | "right" = "left") => s.run?.[panel].map((m) => m.showTime) ?? [];

  test("a message carries its event's time, live and after a replay, and the first of a panel shows it", () => {
    for (const s of [fold(live([started, said("a")], 1, [0, 5])), replayed([started, said("a")], 1, 1, [0, 5])]) {
      expect(s.run?.left[0]?.time).toBe(at(5));
      expect(s.run?.left[0]?.showTime).toBe(true);
    }
  });

  test("the same author within 2 minutes is grouped; exactly 2 minutes too; more than 2 minutes shows the time", () => {
    expect(shown(fold(live([started, said("a"), said("b")], 1, [0, 0, 60])))).toEqual([true, false]);
    expect(shown(fold(live([started, said("a"), said("b")], 1, [0, 0, 120])))).toEqual([true, false]);
    expect(shown(fold(live([started, said("a"), said("b")], 1, [0, 0, 121])))).toEqual([true, true]);
  });

  test("another author shows the time, however close", () => {
    const s = fold(live([started, asked(1, prompts.permissionPrompt), { _tag: "Answered", prompt: 1, text: "y" }, said("c")], 1, [0, 0, 1, 2]));
    expect(s.run?.left.map((m) => m.author)).toEqual(["program", "user", "program"]);
    expect(shown(s)).toEqual([true, true, true]);
  });

  test("each panel groups on its own: a review between two program lines does not separate them, nor a line two reviews", () => {
    const s = fold(live([started, said("a"), review, said("b"), review], 1, [0, 0, 10, 20, 30]));
    expect(shown(s, "left")).toEqual([true, false]);
    expect(shown(s, "right")).toEqual([true, false]);
  });

  test("the gap is measured from the message just before, not from the last one that showed its time", () => {
    const s = fold(live([started, said("a"), said("b"), said("c"), said("d")], 1, [0, 0, 90, 180, 270]));
    expect(shown(s)).toEqual([true, false, false, false]);
  });

  test("an event that makes no message (a blank line, an absorbed line, Ended) does not count as the message before", () => {
    const blank = fold(live([started, said("a"), said("\n"), said("b")], 1, [0, 0, 60, 170]));
    expect(shown(blank)).toEqual([true, true]);
    const turn = notified({ _tag: "InterviewTurn", heading: "Interview", message: "Hi", summary: null });
    const absorbed = fold(live([started, turn, said("\nHi\n"), said("b")], 1, [0, 0, 100, 150]));
    expect(absorbed.run?.left.map((m) => m.body)).toEqual(["Hi", "b"]);
    expect(shown(absorbed)).toEqual([true, true]);
    const ended = fold(live([started, said("a"), { _tag: "Ended", code: 0 }], 1, [0, 0, 500]));
    expect(ended.run?.left.map((m) => [m.time, m.showTime])).toEqual([[at(0), true]]);
  });

  test("a tab that joins late or reconnects folds the replay to the same messages, times and grouping as a live tab", () => {
    const events = [started, said("a"), review, said("b"), asked(1, prompts.decisionPrompt("x")), { _tag: "Answered", prompt: 1, text: "" } as RunEvent, said("c")];
    const times = [0, 1, 2, 30, 200, 210, 400];
    const liveView = fold(live(events, 1, times));
    const late = replayed(events, 1, 1, times);
    const again = fold([hello(1), { type: "replay", runs: [{ id: 1, events: stamp(events, times) }] }], late);
    for (const s of [late, again]) {
      expect(s.run?.left).toEqual(liveView.run?.left);
      expect(s.run?.right).toEqual(liveView.run?.right);
    }
    expect(liveView.run?.left.map((m) => [m.time, m.showTime])).toEqual([[at(1), true], [at(30), false], [at(200), true], [at(210), true], [at(400), true]]);
  });

  test("showsTime: no message before, another author, more than 120 s, or a time that cannot be read", () => {
    const m = { key: "1-1", author: "program" as const, heading: null, body: "a", format: "text" as const, time: at(0), showTime: true };
    expect(showsTime(undefined, "program", at(0))).toBe(true);
    expect(showsTime(m, "user", at(1))).toBe(true);
    expect(showsTime(m, "program", at(120))).toBe(false);
    expect(showsTime(m, "program", at(121))).toBe(true);
    expect(showsTime(m, "program", "not a time")).toBe(true);
    expect(showsTime({ ...m, time: "not a time" }, "program", at(1))).toBe(true);
  });
});
