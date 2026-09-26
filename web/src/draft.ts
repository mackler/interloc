// The unsent text of the prompt widget (finding 5 of docs/gui-review.md), pure. A draft belongs to one prompt of one run
// of one start of the server; it is reconciled against the view after every reduction, live or replayed, so that
// another tab's answer withdraws it with a notice instead of leaving it attached to the next prompt.

import type { ViewState } from "./state.ts";

export type DraftKey = Readonly<{ incarnation: string; run: number; prompt: number }>;
export type Draft = Readonly<{ key: DraftKey; text: string }>;
export type Reconciled = Readonly<{ draft: Draft | null; notice: string | null }>;

/** The notice when another tab's answer overtook this tab's unsent text. */
export const withdrawnNotice = (text: string): string => `This question was answered in another tab; your unsent text was discarded: «${text}»`;

/** The key of the prompt the view waits on, or null. */
export const pendingKey = (view: ViewState): DraftKey | null =>
  view.incarnation === null || view.run === null || view.run.pending === null ? null : { incarnation: view.incarnation, run: view.run.id, prompt: view.run.pending.asked.prompt };

const sameKey = (a: DraftKey, b: DraftKey): boolean => a.incarnation === b.incarnation && a.run === b.run && a.prompt === b.prompt;

/** The draft's text for that key; "" for another key or no draft. */
export const draftFor = (draft: Draft | null, key: DraftKey | null): string => (draft !== null && key !== null && sameKey(draft.key, key) ? draft.text : "");

/**
 * The draft after a reduction of the view, and the notice when it was withdrawn. It is kept while its prompt is
 * pending; it is withdrawn when its prompt was answered (the tab's own send clears the draft first, so that answer
 * came from another tab), or when the server or the run is another one. A non-empty draft is never dropped silently.
 */
export const reconcile = (draft: Draft | null, view: ViewState): Reconciled => {
  if (draft === null) return { draft, notice: null };
  const pending = pendingKey(view);
  if (pending !== null && sameKey(pending, draft.key)) return { draft, notice: null };
  const sameRun = view.incarnation === draft.key.incarnation && view.run !== null && view.run.id === draft.key.run;
  const overtaken = !sameRun || view.run!.answered.includes(draft.key.prompt);
  // A prompt neither pending nor answered in the same run (for example not yet replayed): the draft waits.
  if (!overtaken) return { draft, notice: null };
  return { draft: null, notice: draft.text.trim() === "" ? null : withdrawnNotice(draft.text) };
};
