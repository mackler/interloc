<script lang="ts">
  // The explanation of a term (S28, issue #36): a hand-built M3 rich tooltip, as StepTooltip is, since m3-svelte has
  // none. It asserts only the explanation the agents wrote and Codex reviewed. The text is plain text, never HTML. It is
  // placed inside the viewport, below or above its anchor, with a size limit and its own scrolling.
  // `entries`: one term, or every distinct term of a focused link, in order of occurrence (S40).
  type Entry = Readonly<{ term: string; explanation: string }>;
  // S42: the keyboard inside the tooltip. Tab leaves past its anchor (`onPast`), Shift+Tab and Escape return to the anchor
  // (`onReturn`), and focus leaving for anything but the anchor closes it (`onFocusOut`).
  type Props = {
    id: string;
    entries: readonly Entry[];
    anchor: HTMLElement;
    onEnter: () => void;
    onLeave: () => void;
    onReturn?: () => void;
    onPast?: (e: KeyboardEvent) => void;
    onFocusOut?: (e: FocusEvent) => void;
  };
  let { id, entries, anchor, onEnter, onLeave, onReturn, onPast, onFocusOut }: Props = $props();
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      onReturn?.();
    } else if (e.key === "Tab") onPast?.(e);
  };
  let tip: HTMLDivElement | undefined = $state();
  let place = $state("");
  const MARGIN = 8;
  const MAX_HEIGHT = 256;
  // The edge of the component: measured in the browser when the tooltip opens.
  $effect(() => {
    if (tip === undefined) return;
    const r = anchor.getBoundingClientRect();
    const width = Math.min(tip.offsetWidth, window.innerWidth - 2 * MARGIN);
    const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - width - MARGIN));
    const below = window.innerHeight - r.bottom - 2 * MARGIN;
    const above = r.top - 2 * MARGIN;
    const down = below >= Math.min(tip.scrollHeight, MAX_HEIGHT) || below >= above;
    const height = Math.max(4 * MARGIN, Math.min(MAX_HEIGHT, down ? below : above));
    place = `left:${left}px;${down ? `top:${r.bottom + MARGIN / 2}px` : `bottom:${window.innerHeight - r.top + MARGIN / 2}px`};max-height:${height}px`;
  });
</script>

<!-- The tooltip takes focus so that a long explanation can be scrolled by keyboard, and its keys route focus back to
     its term or past it (S42). -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div role="tooltip" {id} class="tooltip m3-font-body-medium" style={place} tabindex="0" bind:this={tip} onmouseenter={onEnter} onmouseleave={onLeave} onkeydown={onKey} onfocusout={onFocusOut}>
  {#each entries as entry, i (i)}
    <strong class="m3-font-title-small">{entry.term}</strong>
    <p>{entry.explanation}</p>
  {/each}
</div>

<style>
  /* M3 rich tooltip: surface container, on-surface-variant text, elevation level 2, medium shape. */
  .tooltip {
    position: fixed;
    z-index: 10;
    width: max-content;
    max-width: min(20rem, calc(100vw - 16px));
    max-height: 16rem;
    overflow: auto;
    padding: 0.75rem 1rem;
    background: var(--m3c-surface-container);
    color: var(--m3c-on-surface-variant);
    box-shadow: var(--m3-elevation-2);
    border-radius: var(--m3-shape-medium);
  }
  .tooltip:focus-visible { outline: 2px solid var(--m3c-secondary); }
  p { margin: 0.25rem 0 0; }
  p + strong { display: block; margin-top: 0.5rem; }
</style>
