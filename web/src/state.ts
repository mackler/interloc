// The page's state (plan step 4.2): one pure reducer folds the server's messages into the two panels, the pending
// prompt with its widget, the activity line and the timeline rail. Replay and live events use the same fold.

import type { SubjectId } from "../../src/artifacts.ts";
import type { Asked, ServerMessage, Stamped } from "../../src/protocol.ts";
import { clarificationProgress, cycleHeading, cycleLine, interviewHelp, pagePromptText, progressLine, purposeLabel, stepLabel, stepOfPhase, planWrittenHeading, protocolErrorNotice, SERVER_CLOSED_NOTICE, SUMMARY_PROPOSED_HEADING } from "../../src/prompts.ts";
import { interviewSays, optionLines, relayedQuestionMarkdown, relayedQuestionSays, renderResponse, renderReview, subjectHeading } from "../../src/render.ts";
import { correctionCount } from "../../src/issueLog.ts";
import { countOfKind, type LoopResult, type Phase, phaseName, type UiEvent } from "../../src/uiEvents.ts";
import { type Choice, numberedChoices } from "../../src/userPrompts.ts";
import type { RecordedPlan, StepStatus } from "../../src/schema.ts";

export type Author = "program" | "user" | "codex" | "claude";
/**
 * One chat message. `markdown` is rendered and sanitised; a program's plain text is shown as it is. `time` is the ISO
 * time its event was published (issue #1); `showTime` whether the time is shown, or only given to assistive technology.
 */
export type Message = Readonly<{ key: string; author: Author; heading: string | null; body: string; format: "text" | "markdown"; time: string; showTime: boolean; band: Band | null }>;
/**
 * The phase a message belongs to, as its panel shows it (issue #15): a band of one tone per kind of phase, opened by a
 * label with the phase's name and the time it began. `key` is unique per phase of a run; null before any phase.
 */
export type Band = Readonly<{ key: string; kind: Phase["kind"]; name: string; began: string }>;
/** Consecutive messages of one band, in order: how a panel renders its bands. */
export type BandGroup = Readonly<{ band: Band | null; messages: readonly Message[] }>;
/**
 * One cycle of a review loop (issue #14): the issues its review raised and the counted ones, null until the review
 * arrives; the ids of that review, against which a self-correction of the response is judged.
 */
/** `corrections`: those of the round's latest response; a corrective turn's reply replaces them (issue #30). */
export type Cycle = Readonly<{ round: number; raised: number | null; counted: number | null; reviewIds: readonly string[]; corrections?: number }>;
/**
 * The rounds of one review loop within a phase: its cycles, the corrections of its responses (accepted and partially
 * accepted dispositions, effective self-corrections), and how it ended (null while it runs; `done` with it).
 */
export type RoundGroup = Readonly<{ subject: SubjectId; heading: string; rounds: readonly Cycle[]; corrections: number; result: LoopResult | null; done: boolean }>;
/** A step of Gather Requirements (issue #21): its cycles and, for a clarification, the answered questions of the total. */
/**
 * The state of a phase or step (issue #6): foreseen and not yet begun ("ahead"), running, done, stopped, or never reached
 * because the run ended before it.
 */
export type TimelineState = "ahead" | "active" | "done" | "stopped" | "notReached";
/**
 * The state of a step: a phase's states, or "skipped", a step foreseen whose phase ended without needing it (the empty
 * agreed question list without a conversation). Not "notReached", which a halt gives a step the run still needed.
 */
export type StepState = TimelineState | "skipped";
export type TimelineStep = Readonly<{ kind: "formulate" | "clarification" | "followUp"; label: string; state: StepState; count: Readonly<{ answered: number; total: number }> | null; groups: readonly RoundGroup[] }>;
/**
 * A phase of the run in the timeline. `label` is numbered by the count of its kind in the timeline (issue #6), and is
 * renumbered when that count changes; `plan` is the current plan, on the Implementation entry that carries it out (Q5, Q9).
 */
export type TimelineEntry = Readonly<{ phase: Phase; label: string; groups: readonly RoundGroup[]; steps: readonly TimelineStep[]; state: TimelineState; plan: RecordedPlan | null }>;
/** An agent call that runs; calls nest when a decision is taken inside an execution call (P1-R2-1). */
export type AgentCall = Readonly<{ agent: "claude" | "codex"; purpose: string; label: string; startedAt: string }>;
/** The prompt the run waits on, with every choice it offers (the catalog's and those of the preceding event). */
/** A pending prompt: the agent's options (an interview turn's numbered answers or a relayed question's options,
 * rendered as cards) apart from the catalog's fixed choices (buttons), issue #12. */
export type Widget = Readonly<{ asked: Asked; options: readonly Choice[]; choices: readonly Choice[] }>;

export type RunView = Readonly<{
  id: number;
  project: string;
  task: string;
  nextSeq: number;
  left: readonly Message[];
  right: readonly Message[];
  pending: Widget | null;
  /** The prompts answered so far, in order (finding 5): what a draft is reconciled against, live and after a replay. */
  answered: readonly number[];
  activity: string;
  /** Whether an agent call runs: `calls` is not empty. */
  busy: boolean;
  /** The agent calls that run, the innermost last (P1-R2-1). */
  calls: readonly AgentCall[];
  timeline: readonly TimelineEntry[];
  ended: number | null;
  /** Internal to the fold: the terminal lines of the last interview turn or relayed question still to absorb, and the options of the last relayed question and interview message. */
  absorb: readonly string[];
  questionOptions: readonly Choice[];
  interviewChoices: readonly Choice[];
  /** The band of the phase the next message belongs to (issue #15): set when a phase begins, kept until the next one. */
  phase: Band | null;
  /** The last time each panel displays, a message's or a band label's: what the next message's time is measured from. */
  lastShown: Readonly<{ left: string | null; right: string | null }>;
  /**
   * The analysis of the last decision (decision support), shown until the prompt asked again after it is answered:
   * `prompt` is that prompt's number, null until it is asked.
   */
  analysis: Readonly<{ event: Extract<UiEvent, { _tag: "DecisionAnalyzed" }>; prompt: number | null }> | null;
  /** The analysis the last answer dismissed, until the next prompt: restored if the run rejects that answer (W3-R1-1). */
  dismissed: Readonly<{ event: Extract<UiEvent, { _tag: "DecisionAnalyzed" }>; prompt: number | null }> | null;
  /** The current plan with its statuses and the phase that carries it out (issue #6, Q5 and Q9); null before the first. */
  plan: Readonly<{ phase: number; plan: RecordedPlan }> | null;
  /** The phases known of the run, begun or ahead (issue #6). */
  foreseen: readonly Phase[];
}>;

export type Listing = Readonly<{ path: string; parent: string | null; dirs: readonly string[]; error: string | null }>;
export type ViewState = Readonly<{
  connection: "connecting" | "open" | "reconnecting" | "failed";
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
  /** The answers the page could not send and could not put back into the answer field, in order, until dismissed. */
  unsent: readonly string[];
}>;

export const initialState: ViewState = { connection: "connecting", cwd: "", current: null, incarnation: null, run: null, last: null, needsReconnect: false, notices: [], listing: null, unsent: [] };

const AGENT: Record<"claude" | "codex", string> = { claude: "Claude", codex: "Codex" };
const sameSubject = (a: SubjectId, b: SubjectId): boolean => JSON.stringify(a) === JSON.stringify(b);
const isDecision = (subject: SubjectId): boolean => typeof subject === "object" && "decision" in subject;
const samePhase = (a: Phase, b: Phase): boolean => JSON.stringify(a) === JSON.stringify(b);

export const emptyRun = (id: number): RunView => ({
  id,
  project: "",
  task: "",
  nextSeq: 0,
  left: [],
  right: [],
  pending: null,
  answered: [],
  activity: "",
  busy: false,
  calls: [],
  timeline: [],
  ended: null,
  absorb: [],
  questionOptions: [],
  interviewChoices: [],
  phase: null,
  lastShown: { left: null, right: null },
  analysis: null,
  dismissed: null,
  plan: null,
  foreseen: [],
});

/**
 * Decision Q3 of issue #1: consecutive messages of one author in one panel are grouped under one time. Issue #15: the
 * grouping ends when more than this lies since the last time the panel displayed, not since the message before.
 */
const GROUP_GAP_MS = 2 * 60 * 1000;

/** More than the grouping interval from `from` to `to`; a time that cannot be read counts as more (it is shown). */
const beyondGap = (from: string, to: string): boolean => {
  const gap = Date.parse(to) - Date.parse(from);
  return Number.isNaN(gap) || gap > GROUP_GAP_MS;
};
/** A message of `band` after `previous` opens the band in its panel: the band's label is displayed above it. */
const opensBand = (previous: Message | undefined, band: Band | null): band is Band => band !== null && previous?.band?.key !== band.key;

/**
 * Whether a message shows its time (issues #1 and #15). The first message of a band shows it only if more than two
 * minutes lie since the band's label, which displays the time the phase began, whoever wrote it (G-R1-1). Any other
 * message shows it when it is the first of its panel (only before any phase), when its author differs from the message
 * before it, or when more than two minutes lie since `lastShown`, the last time the panel displayed. A time that cannot
 * be read is shown rather than silently grouped. The gap may be negative for events published concurrently.
 */
export const showsTime = (previous: Message | undefined, lastShown: string | null, { author, band, time }: Readonly<{ author: Author; band: Band | null; time: string }>): boolean => {
  if (opensBand(previous, band)) return beyondGap(band.began, time);
  if (previous === undefined || previous.author !== author || lastShown === null) return true;
  return beyondGap(lastShown, time);
};

/** A message before it is placed in its panel, which decides whether it shows its time. */
type Unplaced = Omit<Message, "showTime">;
const message = (run: RunView, time: string, author: Author, body: string, format: Message["format"], heading: string | null = null): Unplaced => ({ key: `${run.id}-${run.nextSeq}`, author, heading, body, format, time, band: run.phase });
/** The run with the message placed in a panel, and the panel's last displayed time after it. */
const place = (run: RunView, side: "left" | "right", m: Unplaced): RunView => {
  const panel = run[side];
  const previous = panel[panel.length - 1];
  const last = run.lastShown[side];
  const showTime = showsTime(previous, last, m);
  const shownLast = showTime ? m.time : opensBand(previous, m.band) ? m.band.began : last;
  const next: readonly Message[] = [...panel, { ...m, showTime }];
  return side === "left" ? { ...run, left: next, lastShown: { ...run.lastShown, left: shownLast } } : { ...run, right: next, lastShown: { ...run.lastShown, right: shownLast } };
};
const withLeft = (run: RunView, m: Unplaced): RunView => place(run, "left", m);
const withRight = (run: RunView, m: Unplaced): RunView => place(run, "right", m);

/** The band of a phase that began at `time`. */
const bandKey = (phase: Phase): string => (phase.kind === "questions" ? "questions" : `${phase.kind}-${phase.n}`);
const bandOf = (phase: Phase, time: string, count: number): Band => ({ key: bandKey(phase), kind: phase.kind, name: phaseName(phase, count), began: time });
/** How many phases of the kind the run holds, begun or foreseen: the timeline holds both (issue #6). */
const countIn = (run: RunView, phase: Phase): number => Math.max(1, countOfKind(run.timeline.map((e) => e.phase), phase.kind));
/**
 * The run with every phase's name derived from the one count (issue #6): the timeline's labels and the bands of both
 * panels. Run after an event that adds a phase, so that "Planning" becomes "Planning 1" everywhere when Planning 2 appears.
 */
const relabel = (run: RunView): RunView => {
  const nameOf = (phase: Phase) => phaseName(phase, countIn(run, phase));
  const byKey = new Map(run.timeline.map((e) => [bandKey(e.phase), nameOf(e.phase)]));
  const band = (b: Band | null): Band | null => (b === null || byKey.get(b.key) === undefined || byKey.get(b.key) === b.name ? b : { ...b, name: byKey.get(b.key) ?? b.name });
  const messages = (list: readonly Message[]) => (list.some((m) => band(m.band) !== m.band) ? list.map((m) => ({ ...m, band: band(m.band) })) : list);
  return { ...run, timeline: run.timeline.map((e) => ({ ...e, label: nameOf(e.phase) })), left: messages(run.left), right: messages(run.right), phase: band(run.phase) };
};
const newEntry = (phase: Phase, state: TimelineState, plan: RecordedPlan | null): TimelineEntry => ({
  phase,
  label: "",
  groups: [],
  steps: phase.kind === "questions" ? [newStep("formulate", null, state), ...(state === "ahead" ? [newStep("clarification", null, "ahead")] : [])] : [],
  state,
  plan,
});
/** The index of the last element that satisfies `p`, or -1 (the page's library has no findLastIndex). */
const lastIndex = <T>(list: readonly T[], p: (t: T) => boolean): number => list.reduce((found, t, i) => (p(t) ? i : found), -1);
/** The entry that the run is in: the active one, else the last one begun. */
const currentIndex = (timeline: readonly TimelineEntry[]): number => {
  const active = lastIndex(timeline, (e) => e.state === "active");
  return active >= 0 ? active : lastIndex(timeline, (e) => e.state !== "ahead" && e.state !== "notReached");
};
/** The step that an entry is in: the active one, else the last one begun. */
const currentStepIndex = (steps: readonly TimelineStep[]): number => {
  const active = lastIndex(steps, (st) => st.state === "active");
  return active >= 0 ? active : lastIndex(steps, (st) => st.state !== "ahead" && st.state !== "notReached" && st.state !== "skipped");
};
/**
 * How a step of the plan shows in the rail (issue #6, G-R1-2): current only while its Implementation entry is active and
 * an execution call runs; a started step otherwise shows as unfinished.
 */
export const planStepState = (entry: TimelineState, status: StepStatus, executing: boolean): "done" | "current" | "unfinished" | "pending" =>
  status === "done" ? "done" : status === "started" ? (entry === "active" && executing ? "current" : "unfinished") : status === "unfinished" ? "unfinished" : "pending";
/** The start of the innermost running call, which the elapsed time is measured from (issue #42, P1-R2-1); null when none runs. */
export const callStartedAt = (run: RunView): string | null => run.calls.at(-1)?.startedAt ?? null;
/** Whether an execution call runs, possibly with nested calls above it (P1-R2-1). */
export const executing = (run: RunView): boolean => run.calls.some((c) => c.purpose === "execution");

/** The messages of a panel grouped into their bands, in order; linear in the number of messages. */
export const bandsOf = (messages: readonly Message[]): readonly BandGroup[] => {
  const starts = messages.flatMap((m, i) => (i === 0 || messages[i - 1].band?.key !== m.band?.key ? [i] : []));
  return starts.map((start, j) => ({ band: messages[start].band, messages: messages.slice(start, starts[j + 1] ?? messages.length) }));
};

/** The half of a round as conversation.md has it, without its "### Codex" / "### Claude Code" heading, which the message's author shows. */
const withoutAuthorHeading = (markdown: string): string => markdown.replace(/^### [^\n]*\n+/, "").trim();

const freshCycle = (round: number): Cycle => ({ round, raised: null, counted: null, reviewIds: [] });
/** The groups with the round in the subject's open group, or in a new group when none is open. */
const withRound = (groups: readonly RoundGroup[], subject: SubjectId, round: number): readonly RoundGroup[] => {
  const open = groups.findIndex((g) => sameSubject(g.subject, subject) && !g.done);
  return open < 0
    ? [...groups, { subject, heading: subjectHeading(subject), rounds: [freshCycle(round)], corrections: 0, result: null, done: false }]
    : groups.map((g, i) => (i === open ? { ...g, rounds: [...g.rounds, freshCycle(round)] } : g));
};
/**
 * The timeline after a round began: the round in its subject's open group of the current entry, or of its last step
 * when the entry has steps (Gather Requirements, issue #21), so a follow-up clarification takes the later cycles.
 */
const roundBegan = (timeline: readonly TimelineEntry[], subject: SubjectId, round: number): readonly TimelineEntry[] => {
  // P1-R1-1: by state, not by position; with the phases ahead in the timeline, the last entry is not the current one.
  const index = currentIndex(timeline);
  const entry = timeline[index];
  if (entry === undefined) return timeline;
  const s = currentStepIndex(entry.steps);
  const next: TimelineEntry = s < 0 ? { ...entry, groups: withRound(entry.groups, subject, round) } : { ...entry, steps: entry.steps.map((st, i) => (i === s ? { ...st, groups: withRound(st.groups, subject, round) } : st)) };
  return timeline.map((e, i) => (i === index ? next : e));
};
/** The timeline with every open group of the subject, in the entries and in their steps, changed by `f`. */
const openGroups = (timeline: readonly TimelineEntry[], subject: SubjectId, f: (g: RoundGroup) => RoundGroup): readonly TimelineEntry[] => {
  const each = (groups: readonly RoundGroup[]) => groups.map((g) => (sameSubject(g.subject, subject) && !g.done ? f(g) : g));
  return timeline.map((e) => ({ ...e, groups: each(e.groups), steps: e.steps.map((st) => ({ ...st, groups: each(st.groups) })) }));
};
const newStep = (kind: TimelineStep["kind"], count: TimelineStep["count"], state: StepState = "active"): TimelineStep => ({ kind, label: stepLabel(kind), state, count, groups: [] });
/**
 * An entry when the run ends with `code`: the active one done or stopped; after a halt, what is ahead not reached (issue #6);
 * after success, the active one's steps never begun skipped (`endSteps`).
 */
const endEntry = (e: TimelineEntry, code: number): TimelineEntry => {
  const end = code === 0 ? "done" : "stopped";
  const unreached = (st: TimelineStep): TimelineStep => (code !== 0 && st.state === "ahead" ? { ...st, state: "notReached" } : st);
  if (e.state === "active") return endSteps({ ...e, state: end, steps: e.steps.map(unreached) }, end);
  return code !== 0 && e.state === "ahead" ? { ...e, state: "notReached", steps: e.steps.map(unreached) } : e;
};
/** The entry with its active steps ended in `state`, and the steps it never began skipped: its phase is over. */
const endSteps = (e: TimelineEntry, state: "done" | "stopped"): TimelineEntry => ({ ...e, steps: e.steps.map((st) => (st.state === "active" ? { ...st, state } : st.state === "ahead" ? { ...st, state: "skipped" } : st)) });
/** The timeline with the last entry's steps changed by `f`, when it is the question phase. */
const inQuestionPhase = (timeline: readonly TimelineEntry[], f: (steps: readonly TimelineStep[]) => readonly TimelineStep[]): readonly TimelineEntry[] =>
  // P1-R1-1: Gather Requirements wherever it stands, while it runs.
  timeline.map((e) => (e.phase.kind === "questions" && e.state === "active" ? { ...e, steps: f(e.steps) } : e));
/** The group with the cycle of `round` changed by `f`. */
const inCycle = (g: RoundGroup, round: number, f: (c: Cycle) => Cycle): RoundGroup => ({ ...g, rounds: g.rounds.map((c) => (c.round === round ? f(c) : c)) });

/** A notified event of the run. */
const notifiedEvent = (run: RunView, event: UiEvent, time: string): RunView => {
  switch (event._tag) {
    case "PhaseBegan": {
      // Issue #6: the foreseen entry becomes active, with its first step; a phase not foreseen is appended.
      const plan = run.plan !== null && event.phase.kind === "execution" && run.plan.phase === event.phase.n ? run.plan.plan : null;
      const foreseen = run.timeline.some((e) => samePhase(e.phase, event.phase));
      const begin = (e: TimelineEntry): TimelineEntry => ({ ...e, state: "active", steps: e.steps.map((st, i) => (i === 0 ? { ...st, state: "active" } : st)) });
      const timeline = foreseen ? run.timeline.map((e) => (samePhase(e.phase, event.phase) ? begin(e) : e)) : [...run.timeline, newEntry(event.phase, "active", plan)];
      const next = { ...run, timeline };
      return relabel({ ...next, phase: bandOf(event.phase, time, countIn(next, event.phase)) });
    }
    case "PhaseEnded":
      return { ...run, activity: "", busy: false, calls: [], timeline: run.timeline.map((e) => (e.state === "active" && samePhase(e.phase, event.phase) ? endSteps({ ...e, state: "done" }, "done") : e)) };
    case "RoundBegan":
      // A decision loop is a loop inside a phase that the progress panel does not show (D12 of the decision-support plan).
      return isDecision(event.subject) ? run : { ...run, timeline: roundBegan(run.timeline, event.subject, event.round) };
    case "LoopFinished":
      return { ...run, timeline: openGroups(run.timeline, event.subject, (g) => ({ ...g, result: event.result, done: true })) };
    case "ReviewReceived": {
      const counts = (c: Cycle): Cycle => ({ ...c, raised: event.review.issues.length, counted: event.counted, reviewIds: event.review.issues.map((i) => i.id) });
      const timeline = openGroups(run.timeline, event.subject, (g) => inCycle(g, event.round, counts));
      const body = event.review.issues.length === 0 ? "No issue: the review has converged." : withoutAuthorHeading(renderReview(event.review));
      return withRight({ ...run, timeline }, message(run, time, "codex", body, "markdown", cycleHeading(subjectHeading(event.subject), event.round)));
    }
    case "ResponseReceived": {
      const response = event.response;
      const corrected = (g: RoundGroup): RoundGroup => {
        const cycle = g.rounds.find((c) => c.round === event.round);
        if (cycle === undefined) return g;
        const rounds = g.rounds.map((c) => (c.round === event.round ? { ...c, corrections: correctionCount(cycle.reviewIds, response) } : c));
        return { ...g, rounds, corrections: rounds.reduce((sum, c) => sum + (c.corrections ?? 0), 0) };
      };
      return withRight({ ...run, timeline: openGroups(run.timeline, event.subject, corrected) }, message(run, time, "claude", withoutAuthorHeading(renderResponse(event.response)), "markdown", cycleHeading(subjectHeading(event.subject), event.round)));
    }
    case "PlanWritten": {
      const questions = event.questions.length === 0 ? "" : `\n\nQuestions for you:\n\n${event.questions.map((q) => `- ${q.question}`).join("\n")}`;
      const body = `**${planWrittenHeading(phaseName({ kind: "planning", n: event.phase }, countIn(run, { kind: "planning", n: event.phase })))}**${event.resultText === "" ? "" : `\n\n${event.resultText}`}${questions}`;
      return withLeft(run, message(run, time, "program", body, "markdown"));
    }
    case "InterviewTurn": {
      const turn = event.summary === null ? { kind: "continuing" as const, message: event.message } : { kind: "summary_proposed" as const, message: event.message, summary: event.summary };
      const body = event.summary === null ? event.message : `${event.message}\n\n**${SUMMARY_PROPOSED_HEADING}**\n\n${event.summary}`;
      // Issue #5: the interview's turns are Claude's words, so they are Claude's messages.
      // Issue #21: the turn's count is the active clarification step's.
      const count = { answered: event.answered, total: event.total };
      const timeline = inQuestionPhase(run.timeline, (steps) => steps.map((st) => (st.state === "active" && st.kind !== "formulate" ? { ...st, count } : st)));
      return { ...withLeft({ ...run, timeline }, message(run, time, "claude", body, "markdown", event.heading)), absorb: interviewSays(turn), interviewChoices: numberedChoices(event.message) };
    }
    case "InterviewOpened": {
      // Issue #21: the step before ends, and the clarification opens as a step with its total.
      const step = newStep(event.stage === "followUp" ? "followUp" : "clarification", { answered: 0, total: event.total });
      // Issue #6: a foreseen Clarification becomes active; a follow-up is appended.
      const opened = (steps: readonly TimelineStep[]): readonly TimelineStep[] => {
        const ended = steps.map((st) => (st.state === "active" ? { ...st, state: "done" as const } : st));
        const ahead = ended.findIndex((st) => st.state === "ahead" && st.kind === step.kind);
        return ahead < 0 ? [...ended, step] : ended.map((st, i) => (i === ahead ? step : st));
      };
      const timeline = inQuestionPhase(run.timeline, opened);
      // The page's own help (finding 8): no terminal """ convention, which the page does not implement.
      return withLeft({ ...run, timeline }, message(run, time, "program", interviewHelp(event.heading, "page"), "text"));
    }
    case "QuestionAsked":
      // Issue #7: a relayed question is Claude's Markdown message; the terminal's lines of it that follow are absorbed.
      return {
        ...withLeft(run, message(run, time, "claude", relayedQuestionMarkdown(event), "markdown")),
        absorb: relayedQuestionSays(event),
        questionOptions: event.options.map((o, i) => ({ label: o.label, sends: String(i + 1) })),
      };
    case "AgentCallStarted": {
      const label = `${AGENT[event.agent]} — ${purposeLabel(event.purpose)}`;
      return { ...run, calls: [...run.calls, { agent: event.agent, purpose: event.purpose, label, startedAt: time }], activity: label, busy: true };
    }
    case "ToolUsed":
      return { ...run, activity: `${run.calls.at(-1)?.label ?? AGENT[event.agent]} — ${event.tool}: ${event.target}`.replace(/: $/, "") };
    case "AgentCallEnded": {
      // P1-R2-1: a nested call ends and the one it ran in is shown again.
      const ended = run.calls.at(-1);
      const calls = run.calls.slice(0, -1);
      const outer = calls.at(-1);
      const activity = outer !== undefined ? outer.label : `${ended?.label ?? AGENT[event.agent]} — ${event.ok ? "done" : "failed"}`;
      return { ...run, calls, activity, busy: calls.length > 0 };
    }
    case "ExecutionEnded":
      return run;
    case "OptionsPresented":
      // The options of the next pause or plan writer's question are its cards; their terminal lines are absorbed.
      return { ...run, absorb: optionLines(event.options), questionOptions: event.options.map((o, i) => ({ label: o.description === "" ? o.label : `${o.label} — ${o.description}`, sends: String(i + 1) })) };
    case "DecisionAnalyzed":
      return { ...run, analysis: { event, prompt: null } };
    case "AnswerRejected":
      // The question is asked again: the analysis its rejected answer dismissed goes to the next prompt.
      return run.dismissed === null ? run : { ...run, analysis: { ...run.dismissed, prompt: null }, dismissed: null };
    case "PhasesForeseen": {
      // Issue #6: every phase known and not yet in the timeline is added ahead; the labels follow the new counts.
      const added = event.phases.filter((p) => !run.timeline.some((e) => samePhase(e.phase, p)));
      const plan = (p: Phase) => (run.plan !== null && p.kind === "execution" && run.plan.phase === p.n ? run.plan.plan : null);
      return relabel({ ...run, foreseen: event.phases, timeline: [...run.timeline, ...added.map((p) => newEntry(p, "ahead", plan(p)))] });
    }
    case "PlanChanged": {
      // Q5, Q9: the plan on the Implementation of its phase alone.
      const carries = (e: TimelineEntry) => e.phase.kind === "execution" && e.phase.n === event.phase;
      return { ...run, plan: { phase: event.phase, plan: event.plan }, timeline: run.timeline.map((e) => (carries(e) ? { ...e, plan: event.plan } : e.plan === null ? e : { ...e, plan: null })) };
    }
    case "ClaudeSaid":
      // Issue #5: Claude's prose is attributed as data, not by a prefix in its text.
      return withLeft(run, message(run, time, "claude", event.text, "markdown"));
  }
};

/** One event of a run with its time, in its order. Pure; the replay folds the same function. */
export const foldEvent = (run: RunView, { time, event }: Stamped): RunView => {
  // The terminal lines of an interview turn or a relayed question are absorbed only while they follow it directly.
  if (event._tag === "Said" && run.absorb.length > 0 && run.absorb[0] === event.text) return { ...run, absorb: run.absorb.slice(1), nextSeq: run.nextSeq + 1 };
  const r: RunView = { ...run, absorb: [] };
  const next = ((): RunView => {
    switch (event._tag) {
      case "Started":
        return { ...r, project: event.project, task: event.task };
      case "Said":
        return event.text.trim() === "" ? r : withLeft(r, message(r, time, "program", event.text, "text"));
      case "Asked": {
        const extra = event.extra === "questionOptions" ? r.questionOptions : event.extra === "numberedAnswers" ? r.interviewChoices : [];
        // Presented options belong to this prompt alone (P1-R1-2); an analysis waiting for its prompt gets this one.
        const analysis = r.analysis !== null && r.analysis.prompt === null ? { ...r.analysis, prompt: event.prompt } : r.analysis;
        return { ...withLeft(r, message(r, time, "program", pagePromptText(event.kind, event.text), "text")), pending: { asked: event, options: extra, choices: event.choices }, questionOptions: [], analysis, dismissed: null };
      }
      case "Answered": {
        const chosen = r.pending !== null && r.pending.asked.prompt === event.prompt ? [...r.pending.options, ...r.pending.choices].find((c) => c.sends === event.text) : undefined;
        const dismisses = r.analysis !== null && r.analysis.prompt === event.prompt;
        const analysis = dismisses ? null : r.analysis;
        const dismissed = dismisses ? r.analysis : r.dismissed;
        return { ...withLeft(r, message(r, time, "user", chosen?.label ?? event.text, "markdown")), pending: r.pending?.asked.prompt === event.prompt ? null : r.pending, answered: [...r.answered, event.prompt], analysis, dismissed };
      }
      case "Notified":
        return notifiedEvent(r, event.event, time);
      case "Ended":
        return { ...r, ended: event.code, pending: null, activity: "", busy: false, calls: [], timeline: r.timeline.map((e) => endEntry(e, event.code)) };
    }
  })();
  return { ...next, nextSeq: run.nextSeq + 1 };
};

const foldRun = (id: number, events: readonly Stamped[]): RunView => events.reduce(foldEvent, emptyRun(id));

/** A notice for the user that the page itself produces (for example an action discarded after a reconnect). */
export const notice = (state: ViewState, text: string): ViewState => ({ ...state, notices: [...state.notices, text] });

/** A frame of the server the page could not read, the count-th in a row: one notice for a run of them (decision Q2). */
export const protocolError = (state: ViewState, reason: string, count: number): ViewState => (count === 1 ? notice(state, protocolErrorNotice(reason)) : state);
/** An answer not sent that could not go back to its field, kept for the user to copy (P1-R1-2). */
export const keepUnsent = (state: ViewState, text: string): ViewState => ({ ...state, unsent: [...state.unsent, text] });
/** The user dismisses one kept answer; the others stay. */
export const dismissUnsent = (state: ViewState, index: number): ViewState => ({ ...state, unsent: state.unsent.filter((_, i) => i !== index) });

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
      // A failed page stays failed: it no longer reconnects, so it must not claim to.
      return notice({ ...state, connection: state.connection === "failed" ? "failed" : "reconnecting" }, SERVER_CLOSED_NOTICE);
    case "event": {
      const current = message.event._tag === "Started" ? message.run : message.event._tag === "Ended" ? null : state.current;
      if (state.run !== null && message.run === state.run.id) {
        if (message.seq !== state.run.nextSeq) return { ...state, needsReconnect: true };
        return { ...state, current, run: foldEvent(state.run, { time: message.time, event: message.event }) };
      }
      if (state.run === null || message.run > state.run.id) {
        if (message.seq !== 0) return { ...state, needsReconnect: true };
        return { ...state, current, last: state.run, run: foldEvent(emptyRun(message.run), { time: message.time, event: message.event }) };
      }
      return state;
    }
  }
};

/** The one-line progress of a compact window: the active (or last) phase and its latest cycle (issue #14: no limit). */
export const progressOf = (run: RunView): string => {
  const entry = run.timeline[currentIndex(run.timeline)];
  if (entry === undefined) return progressLine(null, null);
  const latestCycle = (groups: readonly RoundGroup[]): string | null => {
    const rounds = groups[groups.length - 1]?.rounds ?? [];
    const latest = rounds[rounds.length - 1];
    return latest === undefined ? null : cycleLine(latest.round, null, null);
  };
  const step = entry.steps[currentStepIndex(entry.steps)];
  if (step === undefined) return progressLine(entry.label, latestCycle(entry.groups));
  // Issue #21: the active step, with its running review loop's latest cycle, or else its count.
  const running = step.groups.filter((g) => !g.done);
  const detail = running.length > 0 ? latestCycle(running) : step.count === null ? latestCycle(step.groups) : clarificationProgress(step.count.answered, step.count.total);
  return progressLine(stepOfPhase(entry.label, step.label), detail);
};
