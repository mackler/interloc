<script lang="ts">
  // Rendered text whose terms carry their explanations (S28, issue #36): every occurrence is marked (web/src/terms.ts)
  // after sanitizing, and one TermTooltip opens on hover and on keyboard focus of an occurrence; Escape or leaving
  // closes it [recognition rather than recall: the explanation is where the word is read; help and documentation].
  import { markTerms } from "../terms.ts";
  import { TOOLTIP_GRACE_MS } from "../time.ts";
  import TermTooltip from "./TermTooltip.svelte";

  type Term = Readonly<{ term: string; explanation: string }>;
  type Props = { html: string; terms: readonly Term[]; class?: string; inline?: boolean };
  let { html, terms, class: className = "", inline = false }: Props = $props();
  let open = $state<{ anchor: HTMLElement; index: number } | null>(null);
  const id = `term-tip-${Math.random().toString(36).slice(2)}`;
  let leaving: ReturnType<typeof setTimeout> | null = null;
  const stay = () => {
    if (leaving !== null) clearTimeout(leaving);
    leaving = null;
  };
  // The timer is the component's edge: cleared when the component is destroyed.
  $effect(() => stay);
  const markOf = (target: EventTarget | null): HTMLElement | null => (target instanceof HTMLElement ? target.closest<HTMLElement>(".term") : null);
  const show = (mark: HTMLElement | null) => {
    if (mark === null) return;
    stay();
    open?.anchor.removeAttribute("aria-describedby");
    mark.setAttribute("aria-describedby", id);
    open = { anchor: mark, index: Number(mark.dataset.term) };
  };
  const close = () => {
    stay();
    open?.anchor.removeAttribute("aria-describedby");
    open = null;
  };
  const leave = () => {
    stay();
    leaving = setTimeout(close, TOOLTIP_GRACE_MS);
  };
</script>

<svelte:element
  this={inline ? "span" : "div"}
  class="term-text {className}"
  role="presentation"
  onmouseover={(e: MouseEvent) => show(markOf(e.target))}
  onmouseout={(e: MouseEvent) => markOf(e.target) !== null && leave()}
  onfocusin={(e: FocusEvent) => show(markOf(e.target))}
  onfocusout={(e: FocusEvent) => markOf(e.target) !== null && close()}
  onkeydown={(e: KeyboardEvent) => e.key === "Escape" && close()}>{@html markTerms(html, terms)}</svelte:element>
{#if open !== null && terms[open.index] !== undefined}
  <TermTooltip {id} term={terms[open.index].term} explanation={terms[open.index].explanation} anchor={open.anchor} onEnter={stay} onLeave={leave} />
{/if}

<style>
  .term-text :global(.term) { text-decoration: underline dotted; text-underline-offset: 0.2em; cursor: help; border-radius: var(--m3-shape-extra-small, 4px); }
  .term-text :global(.term:focus-visible) { outline: 2px solid var(--m3c-secondary); outline-offset: 2px; }
  .term-text :global(:first-child) { margin-top: 0; }
  .term-text :global(:last-child) { margin-bottom: 0; }
</style>
