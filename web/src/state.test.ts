import fc from "fast-check";
import { describe, expect, test } from "vitest";
import * as prompts from "../../src/prompts.ts";
import { decodeServer, type RunEvent, type ServerMessage, type Stamped } from "../../src/protocol.ts";
import type { UiEvent } from "../../src/uiEvents.ts";
import { promptOf } from "../../src/userPrompts.ts";
import { type Band, bandsOf, dismissUnsent, initialState, keepUnsent, progressOf, protocolError, reduce, showsTime, type ViewState } from "./state.ts";

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
    const turn: UiEvent = { _tag: "InterviewTurn", heading: "Interview", message: "Which database?\n1. PostgreSQL\n2. SQLite", summary: null, answered: 0, total: 1 };
    const interview = fold(live([started, notified(turn), said("\nWhich database?\n1. PostgreSQL\n2. SQLite\n"), asked(1, prompts.interviewMessagePrompt)]));
    expect(interview.run?.pending?.options.map((c) => `${c.label}=${c.sends}`)).toEqual(["1. PostgreSQL=1", "2. SQLite=2"]);
    expect(interview.run?.pending?.choices.map((c) => `${c.label}=${c.sends}`)).toEqual(["End clarification=/done", "Quit=/quit"]);
    const question: UiEvent = { _tag: "QuestionAsked", question: "A or B?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] };
    const relayed = fold(live([started, notified(question), asked(1, prompts.optionOrTextPrompt)]));
    expect(relayed.run?.pending?.options.map((c) => `${c.label}=${c.sends}`)).toEqual(["A=1", "B=2"]);
    expect(relayed.run?.pending?.choices.map((c) => `${c.label}=${c.sends}`)).toEqual(["Quit=q"]);
  });

  test("an answer to an interview shows the full line of the chosen option, or the fixed choice's label (issue #12, Q2)", () => {
    const turn: UiEvent = { _tag: "InterviewTurn", heading: "Interview", message: "Which database?\n1. PostgreSQL\n2. SQLite", summary: null, answered: 0, total: 1 };
    const answered = (text: string) => fold(live([started, notified(turn), asked(1, prompts.interviewMessagePrompt), { _tag: "Answered", prompt: 1, text }]));
    expect(bodies(answered("2")).at(-1)).toBe("user:2. SQLite");
    expect(bodies(answered("/done")).at(-1)).toBe("user:End clarification");
  });

  test("an answer that is a choice shows the choice's label", () => {
    const s = fold(live([started, asked(1, prompts.permissionPrompt), { _tag: "Answered", prompt: 1, text: "y" }]));
    expect(bodies(s).at(-1)).toBe("user:Allow");
  });

  test("an interview turn and a proposed summary each appear once, live and after a replay", () => {
    const turn: UiEvent = { _tag: "InterviewTurn", heading: "Interview", message: "Hello", summary: null, answered: 0, total: 1 };
    const summary: UiEvent = { _tag: "InterviewTurn", heading: "Interview", message: "Done.", summary: "# R", answered: 0, total: 1 };
    const events: RunEvent[] = [started, notified(turn), said("\nHello\n"), notified(summary), said("\nDone.\n"), said("Summary proposed by Claude Code:\n\n# R\n"), said("\nHello\n")];
    const expected = ["claude:Hello", "claude:Done.\n\n**Summary proposed by Claude:**\n\n# R", "program:\nHello\n"];
    expect(bodies(fold(live(events)))).toEqual(expected);
    expect(bodies(replayed(events))).toEqual(expected);
  });

  test("a plan write is one program message with its result text and questions, live and after a replay", () => {
    const events: RunEvent[] = [started, notified({ _tag: "PlanWritten", phase: 1, questions: [{ question: "Which?", options: [] }], resultText: "I wrote the plan." })];
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
    expect(s.run?.right.map((m) => [m.author, m.heading])).toEqual([["codex", "Planning phase 1, cycle 2"], ["claude", "Planning phase 1, cycle 2"]]);
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
    const turn = notified({ _tag: "InterviewTurn", heading: "Interview", message: "Hi", summary: null, answered: 0, total: 1 });
    const summary = notified({ _tag: "InterviewTurn", heading: "Interview", message: "Done.", summary: "# R", answered: 0, total: 1 });
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
      notified({ _tag: "InterviewOpened", heading: "Interview", stage: "clarification", total: 1 }),
      notified({ _tag: "InterviewTurn", heading: "Interview", message: "Hi", summary: null, answered: 0, total: 1 }),
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
  expect(fold(live([started, asked(1, prompts.limitPrompt(5, "proceed to execution"))])).run?.left.at(-1)?.body).toMatch(/5 cycles completed without convergence/);
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

  test("the activity line names a call's purpose in the user's words: clarification and implementation (issues #14, #21)", () => {
    const of = (purpose: string) => fold(live([started, notified({ _tag: "AgentCallStarted", agent: "claude", purpose })])).run?.activity;
    expect(of("interview")).toBe("Claude — clarification");
    expect(of("execution")).toBe("Claude — implementation");
    expect(of("planning")).toBe("Claude — planning");
    expect(of("review")).toBe("Claude — review");
  });

  test("the question phase stays active through its review loops until PhaseEnded; each loop has its own group; replay agrees", () => {
    const q = { kind: "questions" as const };
    const events: RunEvent[] = [
      started,
      notified({ _tag: "PhaseBegan", phase: q }),
      notified({ _tag: "RoundBegan", subject: "questions", round: 1, limit: 5 }),
      notified({ _tag: "LoopFinished", subject: "questions", result: "converged" }),
      notified({ _tag: "InterviewTurn", heading: "Interview", message: "Hi", summary: null, answered: 0, total: 1 }),
      notified({ _tag: "RoundBegan", subject: "requirements", round: 1, limit: 5 }),
    ];
    const during = fold(live(events));
    const entry = during.run?.timeline[0];
    expect(entry?.state).toBe("active");
    expect(entry?.steps.flatMap((st) => st.groups.map((g) => [g.heading, g.done]))).toEqual([["Question review", true], ["Requirements review", false]]);
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

// Issue #14 (Q1, Q2, G-R1-1): a review's counts and a response's corrections reach the timeline, and the loop's result.
describe("the cycles of a review loop in the timeline", () => {
  const plan = { plan: 1 };
  const issueOf = (id: string, severity: "major" | "minor" = "major") => ({ id, severity, location: "l", problem: "p", evidence: "e" });
  const disposition = (id: string, action: "accepted" | "partially_accepted" | "rejected" | "no_change_needed" | "clarification_requested") => ({ id, action, rationale: "r", duplicate_of: "", reverses: "" });
  const events: RunEvent[] = [
    started,
    notified({ _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } }),
    notified({ _tag: "RoundBegan", subject: plan, round: 1, limit: 5 }),
    notified({ _tag: "ReviewReceived", subject: plan, round: 1, review: { issues: [issueOf("A"), issueOf("B"), issueOf("C", "minor")] }, counted: 2 }),
    notified({
      _tag: "ResponseReceived",
      subject: plan,
      round: 1,
      response: { dispositions: [disposition("A", "accepted"), disposition("B", "partially_accepted"), disposition("C", "rejected")], self_corrections: [{ id: "", new_action: "plan_error", explanation: "x" }, { id: "C", new_action: "accepted", explanation: "x" }], reviewer_feedback: "", questions_for_user: [] },
      resultText: "",
    }),
    notified({ _tag: "RoundBegan", subject: plan, round: 2, limit: 5 }),
  ];
  const groupOf = (s: ViewState) => s.run?.timeline[0].groups[0];

  test("a cycle carries the issues its review raised and the counted ones; a cycle without its review has none yet", () => {
    const s = fold(live(events));
    expect(groupOf(s)?.rounds.map((r) => [r.round, r.raised, r.counted])).toEqual([[1, 3, 2], [2, null, null]]);
    expect(groupOf(s)?.corrections).toBe(3);
    expect(groupOf(s)?.result).toBe(null);
    expect(replayed(events).run?.timeline).toEqual(s.run?.timeline);
  });

  test("LoopFinished records the loop's result; the corrections of every cycle are summed", () => {
    const finished = [...events, notified({ _tag: "ReviewReceived", subject: plan, round: 2, review: { issues: [] }, counted: 0 }), notified({ _tag: "LoopFinished", subject: plan, result: "converged" })];
    const s = fold(live(finished));
    expect(groupOf(s)?.rounds.map((r) => [r.round, r.raised, r.counted])).toEqual([[1, 3, 2], [2, 0, 0]]);
    expect([groupOf(s)?.result, groupOf(s)?.done, groupOf(s)?.corrections]).toEqual(["converged", true, 3]);
    expect(replayed(finished).run?.timeline).toEqual(s.run?.timeline);
  });

  test("a work review that leaves for a revision keeps its count of corrections due, even 0", () => {
    const work = { work: 1 };
    const s = fold(live([started, notified({ _tag: "PhaseBegan", phase: { kind: "work", n: 1 } }), notified({ _tag: "RoundBegan", subject: work, round: 1, limit: 5 }), notified({ _tag: "ReviewReceived", subject: work, round: 1, review: { issues: [issueOf("W1-R1-1")] }, counted: 1 }), notified({ _tag: "LoopFinished", subject: work, result: "revise" })]));
    expect([groupOf(s)?.result, groupOf(s)?.corrections]).toEqual(["revise", 0]);
  });
});

// Issue #21 (Q5, Q6, Q7): Gather Requirements is one phase with its steps: Formulate questions, Clarification and any
// Follow-up clarification, each done, active or stopped, with its cycles and the clarification's count.
describe("the steps of Gather Requirements", () => {
  const q = { kind: "questions" as const };
  const turn = (answered: number, total: number, summary: string | null = null) => notified({ _tag: "InterviewTurn", heading: "Clarification", message: "Hi", summary, answered, total });
  const opened = (stage: "clarification" | "followUp" | "conversation", total: number) => notified({ _tag: "InterviewOpened", heading: "Clarification", stage, total });
  const round = (subject: "questions" | "requirements", n: number) => notified({ _tag: "RoundBegan", subject, round: n, limit: 5 });
  const finished = (subject: "questions" | "requirements") => notified({ _tag: "LoopFinished", subject, result: "converged" });
  const steps = (s: ViewState) => s.run?.timeline[0].steps.map((st) => [st.label, st.state, st.count === null ? null : `${st.count.answered}/${st.count.total}`, st.groups.map((g) => `${g.heading}:${g.rounds.map((c) => c.round).join(",")}`).join(";")]);
  const through = [started, notified({ _tag: "PhaseBegan", phase: q }), round("questions", 1), finished("questions"), opened("clarification", 7), turn(0, 7), turn(3, 7)];

  test("the question phase begins with Formulate questions, which holds the question review's cycles", () => {
    const s = fold(live(through.slice(0, 3)));
    expect(steps(s)).toEqual([["Formulate questions", "active", null, "Question review:1"]]);
    expect(s.run?.timeline[0].groups).toEqual([]);
  });

  test("InterviewOpened ends Formulate questions and opens Clarification with its total; each turn updates the count", () => {
    const s = fold(live(through));
    expect(steps(s)).toEqual([["Formulate questions", "done", null, "Question review:1"], ["Clarification", "active", "3/7", ""]]);
    expect(replayed(through).run?.timeline).toEqual(s.run?.timeline);
  });

  test("the requirements review's cycles go to the latest clarification; a follow-up clarification is a step of its own with the later cycles", () => {
    const events = [...through, turn(7, 7, "# R"), round("requirements", 1), opened("followUp", 1), turn(0, 1), turn(1, 1, "# R2"), round("requirements", 2), finished("requirements"), opened("followUp", 2), notified({ _tag: "PhaseEnded", phase: q, result: "converged" })];
    const s = fold(live(events));
    expect(steps(s)).toEqual([
      ["Formulate questions", "done", null, "Question review:1"],
      ["Clarification", "done", "7/7", "Requirements review:1"],
      ["Follow-up clarification", "done", "1/1", "Requirements review:2"],
      ["Follow-up clarification", "done", "0/2", ""],
    ]);
    expect(s.run?.timeline[0].steps[1].groups[0].result).toBe("converged");
    expect(s.run?.timeline[0].state).toBe("done");
    expect(replayed(events).run?.timeline).toEqual(s.run?.timeline);
  });

  test("the conversation after an empty list is a Clarification whose count starts at 0 of 0", () => {
    const s = fold(live([started, notified({ _tag: "PhaseBegan", phase: q }), round("questions", 1), finished("questions"), opened("conversation", 0)]));
    expect(steps(s)?.at(-1)).toEqual(["Clarification", "active", "0/0", ""]);
  });

  test("a run that ends during a clarification stops that step with its phase; the earlier steps stay done", () => {
    const events = [...through, { _tag: "Ended", code: 130 } as RunEvent];
    const s = fold(live(events));
    expect(s.run?.timeline[0].state).toBe("stopped");
    expect(steps(s)?.map((st) => st[1])).toEqual(["done", "stopped"]);
    expect(replayed(events).run?.timeline).toEqual(s.run?.timeline);
  });

  test("the other phases have no steps", () => {
    const s = fold(live([started, notified({ _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } })]));
    expect(s.run?.timeline[0].steps).toEqual([]);
  });

  test("the compact progress line names the active step and its count, or its latest cycle", () => {
    expect(progressOf(fold(live(through)).run!)).toBe("Progress: Gather Requirements — Clarification, 3 of 7 answered");
    expect(progressOf(fold(live(through.slice(0, 3))).run!)).toBe("Progress: Gather Requirements — Formulate questions, cycle 1");
    expect(progressOf(fold(live([...through, turn(7, 7, "# R"), round("requirements", 1)])).run!)).toBe("Progress: Gather Requirements — Clarification, cycle 1");
  });
});

// Issue #14: the compact window's progress line names the latest cycle, without a limit.
describe("the compact progress line", () => {
  test("the active phase and its latest cycle; none before any phase", () => {
    const planning = fold(live([started, notified({ _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } }), notified({ _tag: "RoundBegan", subject: { plan: 1 }, round: 1, limit: 5 }), notified({ _tag: "RoundBegan", subject: { plan: 1 }, round: 2, limit: 5 })]));
    expect(progressOf(planning.run!)).toBe("Progress: Planning 1, cycle 2");
    expect(progressOf(fold(live([started])).run!)).toBe("Progress: no phase has begun");
    const execution = fold(live([started, notified({ _tag: "PhaseBegan", phase: { kind: "execution", n: 1 } })]));
    expect(progressOf(execution.run!)).toBe("Progress: Implementation 1");
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
      { _tag: "PhaseBegan", phase: { kind: "questions" } },
      { _tag: "InterviewOpened", heading: "Clarification", stage: "clarification", total: 2 },
      { _tag: "RoundBegan", subject: { plan: 1 }, round: 1, limit: 5 },
      { _tag: "ReviewReceived", subject: { plan: 1 }, round: 1, review: { issues: [{ id: "A", severity: "major", location: "l", problem: "p", evidence: "e" }] }, counted: 1 },
      { _tag: "ResponseReceived", subject: { plan: 1 }, round: 1, response: { dispositions: [{ id: "A", action: "accepted", rationale: "r", duplicate_of: "", reverses: "" }], self_corrections: [], reviewer_feedback: "", questions_for_user: [] }, resultText: "" },
      { _tag: "LoopFinished", subject: { plan: 1 }, result: "converged" },
      { _tag: "PhaseEnded", phase: { kind: "planning", n: 1 }, result: "converged" },
      { _tag: "InterviewTurn", heading: "Interview", message: "Hi", summary: null, answered: 0, total: 1 },
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
    const s = fold(live([started, notified({ _tag: "InterviewOpened", heading: "Interview", stage: "clarification", total: 1 })]));
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
      notified({ _tag: "InterviewOpened", heading: "Interview", stage: "clarification", total: 1 }),
      notified({ _tag: "InterviewTurn", heading: "Interview", message: "Which database should the service use?\n1. PostgreSQL\n2. SQLite", summary: null, answered: 0, total: 1 }),
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
    expect(s.run?.pending?.choices.map((c) => `${c.label}=${c.sends}`)).toEqual(["End clarification=/done", "Quit=/quit"]);
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

  // Issue #15: the gap is measured from the last time shown in the panel, so no long span goes unmarked.
  test("thirty messages 90 s apart show a time whenever more than 2 minutes lie since the last time shown", () => {
    const lines = Array.from({ length: 30 }, (_, i) => said(`line ${i}`));
    const times = [0, ...lines.map((_, i) => i * 90)];
    const expected = lines.map((_, i) => i % 2 === 0);
    expect(shown(fold(live([started, ...lines], 1, times)))).toEqual(expected);
    expect(shown(replayed([started, ...lines], 1, 1, times))).toEqual(expected);
  });

  test("a message just inside 2 minutes of the last time shown stays grouped", () => {
    expect(shown(fold(live([started, said("a"), said("b"), said("c")], 1, [0, 0, 60, 119])))).toEqual([true, false, false]);
  });

  test("an event that makes no message (a blank line, an absorbed line, Ended) does not count as the message before", () => {
    const blank = fold(live([started, said("a"), said("\n"), said("b")], 1, [0, 0, 60, 170]));
    expect(shown(blank)).toEqual([true, true]);
    const turn = notified({ _tag: "InterviewTurn", heading: "Interview", message: "Hi", summary: null, answered: 0, total: 1 });
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

  test("showsTime: no message before, another author, more than 120 s since the last time shown, or a time that cannot be read", () => {
    const m = { key: "1-1", author: "program" as const, heading: null, body: "a", format: "text" as const, time: at(0), showTime: true, band: null };
    const next = (author: "program" | "user", time: string, band: Band | null = null) => ({ author, band, time });
    expect(showsTime(undefined, null, next("program", at(0)))).toBe(true);
    expect(showsTime(m, at(0), next("user", at(1)))).toBe(true);
    expect(showsTime(m, at(0), next("program", at(120)))).toBe(false);
    expect(showsTime(m, at(0), next("program", at(121)))).toBe(true);
    // Measured from the last time shown, not from the message just before (issue #15).
    expect(showsTime({ ...m, time: at(100) }, at(0), next("program", at(121)))).toBe(true);
    expect(showsTime(m, at(0), next("program", "not a time"))).toBe(true);
    expect(showsTime(m, "not a time", next("program", at(1)))).toBe(true);
    // The first message of a band: measured from the band's label, whoever wrote it (G-R1-1).
    const band: Band = { key: "planning-1", kind: "planning", name: "Planning 1", began: at(100) };
    expect(showsTime(m, at(0), next("user", at(130), band))).toBe(false);
    expect(showsTime(undefined, null, next("user", at(221), band))).toBe(true);
    expect(showsTime({ ...m, band, time: at(130), showTime: false }, at(100), next("program", at(200), band))).toBe(false);
  });
});

// Issue #15: each phase is a band in each panel where it places a message, opened by a label with its name and the
// time it began; the label's time counts as shown (G-R1-1).
describe("phase bands", () => {
  const began = (phase: UiEvent extends infer E ? (E extends { _tag: "PhaseBegan"; phase: infer P } ? P : never) : never): RunEvent => notified({ _tag: "PhaseBegan", phase });
  const planning = (n: number) => began({ kind: "planning", n });
  const execution = (n: number) => began({ kind: "execution", n });
  const review = notified({ _tag: "ReviewReceived", subject: { plan: 1 }, round: 1, review: { issues: [] }, counted: 0 });
  const views = (events: readonly RunEvent[], times: readonly number[]) => [fold(live(events, 1, times)), replayed(events, 1, 1, times)];
  const shown = (s: ViewState, panel: "left" | "right" = "left") => s.run?.[panel].map((m) => m.showTime) ?? [];

  test("a message before any phase has no band and shows its time as the first of its panel", () => {
    for (const s of views([started, said("a")], [0, 5])) {
      expect(s.run?.left.map((m) => [m.band, m.showTime])).toEqual([[null, true]]);
    }
  });

  test("the first message after a label shows no time within 2 minutes of it, although it is the first of its panel", () => {
    for (const s of views([started, planning(1), said("a"), said("b"), said("c")], [0, 100, 130, 200, 260])) {
      expect(s.run?.left[0]?.band).toEqual({ key: "planning-1", kind: "planning", name: "Planning 1", began: at(100) });
      expect(shown(s)).toEqual([false, false, true]);
    }
  });

  test("the first message after a label shows its time more than 2 minutes after it, whoever wrote it", () => {
    for (const s of views([started, said("a"), planning(1), said("b")], [0, 0, 10, 131])) {
      expect(shown(s)).toEqual([true, true]);
    }
    const answered: RunEvent = { _tag: "Answered", prompt: 1, text: "y" };
    for (const s of views([started, said("a"), planning(1), asked(1, prompts.permissionPrompt), answered], [0, 0, 10, 20, 30])) {
      // The prompt is exempt from the change of author, being the band's first; the answer after it is not.
      expect(shown(s)).toEqual([true, false, true]);
    }
  });

  test("a message of the right panel opens the phase's band there; a phase without a message there makes none", () => {
    for (const s of views([started, planning(1), said("a"), review, execution(1), said("x")], [0, 0, 1, 300, 310, 311])) {
      expect(s.run?.right.map((m) => [m.band?.key, m.showTime])).toEqual([["planning-1", true]]);
      expect(bandsOf(s.run?.right ?? []).map((g) => g.band?.key)).toEqual(["planning-1"]);
      expect(bandsOf(s.run?.left ?? []).map((g) => g.band?.key)).toEqual(["planning-1", "execution-1"]);
    }
  });

  test("the lines after a phase ends stay in its band until the next phase begins", () => {
    const ended = notified({ _tag: "PhaseEnded", phase: { kind: "planning", n: 1 }, result: "converged" });
    for (const s of views([started, planning(1), said("a"), ended, said("b")], [0, 0, 1, 2, 3])) {
      expect(s.run?.left.map((m) => m.band?.key)).toEqual(["planning-1", "planning-1"]);
    }
  });

  test("bandsOf groups consecutive messages of a band: before any phase, execution, planning, execution", () => {
    const events = [started, said("m0"), execution(1), said("e1"), planning(2), said("p1"), said("p2"), execution(2), said("e2")];
    for (const s of views(events, events.map((_, i) => i))) {
      const groups = bandsOf(s.run?.left ?? []);
      expect(groups.map((g) => [g.band?.kind ?? null, g.band?.name ?? null, g.messages.map((m) => m.body)])).toEqual([
        [null, null, ["m0"]],
        ["execution", "Implementation 1", ["e1"]],
        ["planning", "Planning 2", ["p1", "p2"]],
        ["execution", "Implementation 2", ["e2"]],
      ]);
    }
  });

  test("a tab that joins late folds the bands and their times as a live tab does", () => {
    const events = [started, said("a"), began({ kind: "questions" }), said("b"), review, planning(1), said("c"), review];
    const times = [0, 1, 2, 3, 4, 200, 201, 202];
    const liveView = fold(live(events, 1, times));
    const late = replayed(events, 1, 1, times);
    expect(late.run?.left).toEqual(liveView.run?.left);
    expect(late.run?.right).toEqual(liveView.run?.right);
    expect(liveView.run?.right.map((m) => [m.band?.key, m.showTime])).toEqual([["questions", false], ["planning-1", false]]);
  });
});

// Decision support, plan step 3.6.
describe("decision support", () => {
  const positions = [{ label: "Follow Codex", description: "the issue" }, { label: "Follow Claude", description: "the rationale" }];
  const presented: UiEvent = { _tag: "OptionsPresented", question: "issue A", options: positions };
  const analysis = { decision: "d", columns: [], recommendation: { option: "", reason: "" } };
  const analyzed = (decision: number): UiEvent => ({ _tag: "DecisionAnalyzed", decision, question: "issue A", options: positions, analysis });

  test("presented options become the cards of the next decision prompt; their terminal lines are absorbed; the offer is a choice", () => {
    const s = fold(live([started, notified(presented), said("  1. Follow Codex - the issue"), said("  2. Follow Claude - the rationale"), asked(1, prompts.withOffer(prompts.decisionPrompt("issue A")))]));
    expect(s.run?.pending?.options.map((c) => `${c.label}=${c.sends}`)).toEqual(["Follow Codex — the issue=1", "Follow Claude — the rationale=2"]);
    expect(s.run?.pending?.choices.map((c) => `${c.label}=${c.sends}`)).toEqual(["No decision=", `${prompts.HELP_ME_DECIDE}=/decide`, "Quit=q"]);
    expect(bodies(s)).toEqual(["program:Decision on: issue A"]);
    const helped = fold([{ type: "event", run: 1, seq: 5, time: at(5), event: { _tag: "Answered", prompt: 1, text: "/decide" } }], s);
    expect(bodies(helped).at(-1)).toBe(`user:${prompts.HELP_ME_DECIDE}`);
  });

  test("options never outlive their prompt: a pause without options after one with options shows no cards", () => {
    const s = fold(live([started, notified(presented), asked(1, prompts.decisionPrompt("issue A")), { _tag: "Answered", prompt: 1, text: "1" }, asked(2, prompts.decisionPrompt("the idle cycles"))]));
    expect(s.run?.pending?.options).toEqual([]);
  });

  test("after a nested decision the outer question's options are presented again (P1-R1-3)", () => {
    const outer: UiEvent = { _tag: "QuestionAsked", question: "A or B?", options: [{ label: "A", description: "" }, { label: "B", description: "" }] };
    const inner: UiEvent = { _tag: "QuestionAsked", question: "C or D?", options: [{ label: "C", description: "" }, { label: "D", description: "" }] };
    const s = fold(live([
      started,
      notified(outer),
      asked(1, prompts.withOffer(prompts.optionOrTextPrompt)),
      { _tag: "Answered", prompt: 1, text: "/decide" },
      notified(inner),
      asked(2, prompts.withOffer(prompts.optionOrTextPrompt)),
      { _tag: "Answered", prompt: 2, text: "1" },
      notified(analyzed(1)),
      notified(outer),
      asked(3, prompts.withOffer(prompts.optionOrTextPrompt)),
    ]));
    expect(s.run?.pending?.options.map((c) => c.label)).toEqual(["A", "B"]);
  });

  test("an analysis is kept for the reasked prompt and cleared by its answer; a decision loop adds nothing to the rail", () => {
    const loop: RunEvent[] = [
      notified({ _tag: "RoundBegan", subject: { decision: 1 }, round: 1, limit: 5 }),
      notified({ _tag: "ReviewReceived", subject: { decision: 1 }, round: 1, review: { issues: [] }, counted: 0 }),
      notified({ _tag: "LoopFinished", subject: { decision: 1 }, result: "converged" }),
    ];
    const before = fold(live([started, notified({ _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } }), asked(1, prompts.withOffer(prompts.decisionPrompt("issue A"))), { _tag: "Answered", prompt: 1, text: "/decide" }]));
    const s = fold(live([started, notified({ _tag: "PhaseBegan", phase: { kind: "planning", n: 1 } }), asked(1, prompts.withOffer(prompts.decisionPrompt("issue A"))), { _tag: "Answered", prompt: 1, text: "/decide" }, ...loop, notified(analyzed(1)), asked(2, prompts.withOffer(prompts.decisionPrompt("issue A")))]));
    expect(s.run?.timeline).toEqual(before.run?.timeline);
    expect(progressOf(s.run!)).toBe(progressOf(before.run!));
    expect(s.run?.analysis?.event.decision).toBe(1);
    expect(s.run?.analysis?.prompt).toBe(2);
    const answered = fold([{ type: "event", run: 1, seq: 9, time: at(9), event: { _tag: "Answered", prompt: 2, text: "1" } }], s);
    expect(answered.run?.analysis).toBe(null);
    // A replay folds alike.
    expect(replayed([started, notified(analyzed(3)), asked(1, prompts.withOffer(prompts.decisionPrompt("x")))]).run?.analysis?.event.decision).toBe(3);
  });
});
