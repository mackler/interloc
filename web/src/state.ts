// The page's state (plan step 4.2): one pure reducer folds the server's messages into the two panels, the pending
// prompt with its widget, the activity line and the timeline rail. Replay and live events use the same fold.

import type { SubjectId } from "../../src/artifacts.ts";
import type { Asked, RunEvent, ServerMessage } from "../../src/protocol.ts";
import { pagePromptText } from "../../src/prompts.ts";
import { interviewSays, renderResponse, renderReview, subjectHeading } from "../../src/render.ts";
import { type Phase, phaseName, type UiEvent } from "../../src/uiEvents.ts";
import { type Choice, numberedChoices } from "../../src/userPrompts.ts";

export type Author = "program" | "user" | "codex" | "claude";
/** One chat message. `markdown` is rendered and sanitised; a program's plain text is shown as it is. */
export type Message = Readonly<{ key: string; author: Author; heading: string | null; body: string; format: "text" | "markdown" }>;
/** The rounds of one review loop within a phase. */
export type RoundGroup = Readonly<{ subject: SubjectId; heading: string; rounds: readonly Readonly<{ round: number; limit: number }>[]; done: boolean }>;
export type TimelineEntry = Readonly<{ phase: Phase; label: string; groups: readonly RoundGroup[]; state: "active" | "done" | "stopped" }>;
/** The prompt the run waits on, with every choice it offers (the catalog's and those of the preceding event). */
export type Widget = Readonly<{ asked: Asked; choices: readonly Choice[] }>;

export type RunView = Readonly<{
  id: number;
  project: string;
  task: string;
  nextSeq: number;
  left: readonly Message[];
  right: readonly Message[];
  pending: Widget | null;
  activity: string;
  busy: boolean;
  timeline: readonly TimelineEntry[];
  ended: number | null;
  /** Internal to the fold: the terminal lines of the last interview turn still to absorb, and the options of the last relayed question and interview message. */
  absorb: readonly string[];
  questionOptions: readonly Choice[];
  interviewChoices: readonly Choice[];
  /** The activity line's prefix while an agent call runs, for example "Codex — review". */
  callLabel: string;
}>;

export type Listing = Readonly<{ path: string; parent: string | null; dirs: readonly string[]; error: string | null }>;
export type ViewState = Readonly<{
  connection: "connecting" | "open" | "reconnecting";
  cwd: string;
  /** The id of the run in progress on the server, as the last hello or event reported it. */
  current: number | null;
  /** The server's incarnation from the last hello (finding 12); null before the first. */
  incarnation: string | null;
  /** The newest run (in progress or ended) and the one before it. */
  run: RunView | null;
  last: RunView | null;
  /** A seq that did not follow: the page must reconnect to receive the replay. */
  needsReconnect: boolean;
  /** Messages from the server or the page for the user: refusals and notices. */
  notices: readonly string[];
  listing: Listing | null;
}>;

export const initialState: ViewState = { connection: "connecting", cwd: "", current: null, incarnation: null, run: null, last: null, needsReconnect: false, notices: [], listing: null };

const AGENT: Record<"claude" | "codex", string> = { claude: "Claude Code", codex: "Codex" };
const sameSubject = (a: SubjectId, b: SubjectId): boolean => JSON.stringify(a) === JSON.stringify(b);
const samePhase = (a: Phase, b: Phase): boolean => JSON.stringify(a) === JSON.stringify(b);

export const emptyRun = (id: number): RunView => ({
  id,
  project: "",
  task: "",
  nextSeq: 0,
  left: [],
  right: [],
  pending: null,
  activity: "",
  busy: false,
  timeline: [],
  ended: null,
  absorb: [],
  questionOptions: [],
  interviewChoices: [],
  callLabel: "",
});

const message = (run: RunView, author: Author, body: string, format: Message["format"], heading: string | null = null): Message => ({ key: `${run.id}-${run.nextSeq}`, author, heading, body, format });
const withLeft = (run: RunView, m: Message): RunView => ({ ...run, left: [...run.left, m] });

/** The half of a round as conversation.md has it, without its "### Codex" / "### Claude Code" heading, which the message's author shows. */
const withoutAuthorHeading = (markdown: string): string => markdown.replace(/^### [^\n]*\n+/, "").trim();

/** The timeline after a round began: the round in its subject's open group of the current entry. */
const roundBegan = (timeline: readonly TimelineEntry[], subject: SubjectId, round: number, limit: number): readonly TimelineEntry[] => {
  const last = timeline[timeline.length - 1];
  if (last === undefined) return timeline;
  const open = last.groups.findIndex((g) => sameSubject(g.subject, subject) && !g.done);
  const groups =
    open < 0
      ? [...last.groups, { subject, heading: subjectHeading(subject), rounds: [{ round, limit }], done: false }]
      : last.groups.map((g, i) => (i === open ? { ...g, rounds: [...g.rounds, { round, limit }] } : g));
  return [...timeline.slice(0, -1), { ...last, groups }];
};

/** A notified event of the run. */
const notifiedEvent = (run: RunView, event: UiEvent): RunView => {
  switch (event._tag) {
    case "PhaseBegan":
      return { ...run, timeline: [...run.timeline, { phase: event.phase, label: phaseName(event.phase), groups: [], state: "active" }] };
    case "PhaseEnded":
      return { ...run, activity: "", busy: false, timeline: run.timeline.map((e) => (e.state === "active" && samePhase(e.phase, event.phase) ? { ...e, state: "done" } : e)) };
    case "RoundBegan":
      return { ...run, timeline: roundBegan(run.timeline, event.subject, event.round, event.limit) };
    case "LoopFinished":
      return { ...run, timeline: run.timeline.map((e) => ({ ...e, groups: e.groups.map((g) => (sameSubject(g.subject, event.subject) ? { ...g, done: true } : g)) })) };
    case "ReviewReceived": {
      const body = event.review.issues.length === 0 ? "No issue: the review has converged." : withoutAuthorHeading(renderReview(event.review));
      return { ...run, right: [...run.right, message(run, "codex", body, "markdown", `${subjectHeading(event.subject)}, round ${event.round}`)] };
    }
    case "ResponseReceived":
      return { ...run, right: [...run.right, message(run, "claude", withoutAuthorHeading(renderResponse(event.response)), "markdown", `${subjectHeading(event.subject)}, round ${event.round}`)] };
    case "PlanWritten": {
      const questions = event.questions.length === 0 ? "" : `\n\nQuestions for you:\n\n${event.questions.map((q) => `- ${q}`).join("\n")}`;
      const body = `**Claude Code wrote the plan (planning phase ${event.phase}).**${event.resultText === "" ? "" : `\n\n${event.resultText}`}${questions}`;
      return withLeft(run, message(run, "program", body, "markdown"));
    }
    case "InterviewTurn": {
      const turn = event.summary === null ? { kind: "continuing" as const, message: event.message } : { kind: "summary_proposed" as const, message: event.message, summary: event.summary };
      const body = event.summary === null ? event.message : `${event.message}\n\n**Summary proposed by Claude Code:**\n\n${event.summary}`;
      return { ...withLeft(run, message(run, "program", body, "markdown", event.heading)), absorb: interviewSays(turn), interviewChoices: numberedChoices(event.message) };
    }
    case "QuestionAsked":
      return { ...run, questionOptions: event.options.map((o, i) => ({ label: o.label, sends: String(i + 1) })) };
    case "AgentCallStarted": {
      const callLabel = `${AGENT[event.agent]} — ${event.purpose}`;
      return { ...run, callLabel, activity: callLabel, busy: true };
    }
    case "ToolUsed":
      return { ...run, activity: `${run.callLabel || AGENT[event.agent]} — ${event.tool}: ${event.target}`.replace(/: $/, "") };
    case "AgentCallEnded":
      return { ...run, activity: `${run.callLabel || AGENT[event.agent]} — ${event.ok ? "done" : "failed"}`, busy: false };
    case "ExecutionEnded":
      return run;
  }
};

/** One event of a run, in its order. Pure; the replay folds the same function. */
export const foldEvent = (run: RunView, event: RunEvent): RunView => {
  // The terminal lines of an interview turn are absorbed only while they follow it directly.
  if (event._tag === "Said" && run.absorb.length > 0 && run.absorb[0] === event.text) return { ...run, absorb: run.absorb.slice(1), nextSeq: run.nextSeq + 1 };
  const r: RunView = { ...run, absorb: [] };
  const next = ((): RunView => {
    switch (event._tag) {
      case "Started":
        return { ...r, project: event.project, task: event.task };
      case "Said":
        return event.text.trim() === "" ? r : withLeft(r, message(r, "program", event.text, "text"));
      case "Asked": {
        const extra = event.extra === "questionOptions" ? r.questionOptions : event.extra === "numberedAnswers" ? r.interviewChoices : [];
        return { ...withLeft(r, message(r, "program", pagePromptText(event.kind, event.text), "text")), pending: { asked: event, choices: [...extra, ...event.choices] } };
      }
      case "Answered": {
        const chosen = r.pending !== null && r.pending.asked.prompt === event.prompt ? r.pending.choices.find((c) => c.sends === event.text) : undefined;
        return { ...withLeft(r, message(r, "user", chosen?.label ?? event.text, "text")), pending: r.pending?.asked.prompt === event.prompt ? null : r.pending };
      }
      case "Notified":
        return notifiedEvent(r, event.event);
      case "Ended":
        return { ...r, ended: event.code, pending: null, activity: "", busy: false, timeline: r.timeline.map((e) => (e.state === "active" ? { ...e, state: event.code === 0 ? "done" : "stopped" } : e)) };
    }
  })();
  return { ...next, nextSeq: run.nextSeq + 1 };
};

const foldRun = (id: number, events: readonly RunEvent[]): RunView => events.reduce(foldEvent, emptyRun(id));

export const SERVER_CLOSED = "The server has ended. The page reconnects when it is started again.";
/** A notice for the user that the page itself produces (for example an action discarded after a reconnect). */
export const notice = (state: ViewState, text: string): ViewState => ({ ...state, notices: [...state.notices, text] });

/** The next state after a message of the server. Pure. */
export const reduce = (state: ViewState, message: ServerMessage): ViewState => {
  switch (message.type) {
    case "hello": {
      // Another start of the server: its run numbers restart, so the views of the earlier server's runs are dropped.
      const restarted = state.incarnation !== null && state.incarnation !== message.incarnation;
      const runs = restarted ? { run: null, last: null } : {};
      return { ...state, ...runs, connection: "open", cwd: message.cwd, current: message.current, incarnation: message.incarnation, needsReconnect: false };
    }
    case "replay": {
      const views = message.runs.map((r) => foldRun(r.id, r.events));
      return { ...state, run: views[views.length - 1] ?? null, last: views[views.length - 2] ?? null };
    }
    case "listing":
      return { ...state, listing: { path: message.path, parent: message.parent, dirs: message.dirs, error: message.error } };
    case "refused":
      return notice(state, message.reason);
    case "closing":
      // [visibility of system status] The socket's reconnection keeps trying; the page says why it is disconnected.
      return notice({ ...state, connection: "reconnecting" }, SERVER_CLOSED);
    case "event": {
      const current = message.event._tag === "Started" ? message.run : message.event._tag === "Ended" ? null : state.current;
      if (state.run !== null && message.run === state.run.id) {
        if (message.seq !== state.run.nextSeq) return { ...state, needsReconnect: true };
        return { ...state, current, run: foldEvent(state.run, message.event) };
      }
      if (state.run === null || message.run > state.run.id) {
        if (message.seq !== 0) return { ...state, needsReconnect: true };
        return { ...state, current, last: state.run, run: foldEvent(emptyRun(message.run), message.event) };
      }
      return state;
    }
  }
};
