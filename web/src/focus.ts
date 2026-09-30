// Keyboard focus routing for the hand-built tooltips (S42, P3-R1-3).

/**
 * The first element after `anchor` in `focusables` (in document order) that is not inside the excluded subtree, or null
 * when none follows. Pure: `excluded` says whether an element lies in the subtree being closed.
 */
export const nextFocusable = <E>(focusables: readonly E[], anchor: E, excluded: (e: E) => boolean): E | null => {
  const at = focusables.indexOf(anchor);
  return at < 0 ? null : (focusables.slice(at + 1).find((e) => !excluded(e)) ?? null);
};

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The focusable elements of the document in document order. An edge: it reads the DOM. */
export const focusablesOf = (doc: Document): readonly HTMLElement[] => [...doc.querySelectorAll<HTMLElement>(FOCUSABLE)];
