// The page's layout state at compact widths (finding 7 of docs/gui-review.md, decision Q3), pure. Below M3's expanded
// breakpoint only one of the two panels is shown; the other's new messages are counted for its badge, and a new
// prompt selects "You and plan-review", where the prompt is answered.

import type { DraftKey } from "./draft.ts";

export type Pane = "left" | "right";
export type Counts = Readonly<Record<Pane, number>>;
export type Layout = Readonly<{ selected: Pane; unseen: Counts; counts: Counts; prompt: DraftKey | null }>;
/**
 * What the layout observes of the view: each panel's message count and the pending prompt, by its full key
 * (incarnation, run, prompt), since prompt numbers restart with each run and each start of the server (W2-R1-1).
 */
export type Observed = Readonly<{ counts: Counts; prompt: DraftKey | null }>;

const sameKey = (a: DraftKey | null, b: DraftKey | null): boolean =>
  a === null || b === null ? a === b : a.incarnation === b.incarnation && a.run === b.run && a.prompt === b.prompt;

/** M3's expanded window class begins at 840 dp. */
export const EXPANDED_MIN_WIDTH = 840;

export const initialLayout: Layout = { selected: "left", unseen: { left: 0, right: 0 }, counts: { left: 0, right: 0 }, prompt: null };

/** The layout after the view changed; `compact` when the window is narrower than the expanded class. */
export const observe = (layout: Layout, observed: Observed, compact: boolean): Layout => {
  const newPrompt = observed.prompt !== null && !sameKey(observed.prompt, layout.prompt);
  const selected: Pane = newPrompt ? "left" : layout.selected;
  // A panel with fewer messages than before belongs to a new run: its count starts again.
  const added = (pane: Pane): number => Math.max(0, observed.counts[pane] - layout.counts[pane]);
  const count = (pane: Pane): number => (!compact || pane === selected ? 0 : observed.counts[pane] < layout.counts[pane] ? 0 : layout.unseen[pane] + added(pane));
  return { selected, unseen: { left: count("left"), right: count("right") }, counts: observed.counts, prompt: observed.prompt };
};

/** The user selects a panel; its unseen count is cleared. */
export const select = (layout: Layout, pane: Pane): Layout => ({ ...layout, selected: pane, unseen: { ...layout.unseen, [pane]: 0 } });
