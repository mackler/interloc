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
  // The open tooltip: its anchor (a mark, or a link that contains marks, S40) and the terms it explains, in order.
  let open = $state<{ anchor: HTMLElement; indices: readonly number[] } | null>(null);
  const id = `term-tip-${Math.random().toString(36).slice(2)}`;
  let leaving: ReturnType<typeof setTimeout> | null = null;
  const stay = () => {
    if (leaving !== null) clearTimeout(leaving);
    leaving = null;
  };
  // The timer is the component's edge: cleared when the component is destroyed.
  $effect(() => stay);
  const markOf = (target: EventTarget | null): HTMLElement | null => (target instanceof HTMLElement ? target.closest<HTMLElement>(".term") : null);
  // A focused link explains every distinct term it contains, in order of occurrence (S40, P3-R1-2).
  const linkOf = (target: EventTarget | null): HTMLElement | null => (target instanceof HTMLAnchorElement && target.querySelector(".term") !== null ? target : null);
  const termsOf = (anchor: HTMLElement): readonly number[] =>
    anchor.classList.contains("term") ? [Number(anchor.dataset.term)] : [...new Set([...anchor.querySelectorAll<HTMLElement>(".term")].map((m) => Number(m.dataset.term)))];
  const anchorOf = (target: EventTarget | null): HTMLElement | null => linkOf(target) ?? markOf(target);
  const show = (anchor: HTMLElement | null) => {
    if (anchor === null) return;
    stay();
    open?.anchor.removeAttribute("aria-describedby");
    anchor.setAttribute("aria-describedby", id);
    open = { anchor, indices: termsOf(anchor) };
  };
  const entries = $derived(open === null ? [] : open.indices.flatMap((i) => (terms[i] === undefined ? [] : [terms[i]])));
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
  onfocusin={(e: FocusEvent) => show(anchorOf(e.target))}
  onfocusout={(e: FocusEvent) => anchorOf(e.target) !== null && close()}
  onkeydown={(e: KeyboardEvent) => e.key === "Escape" && close()}>{@html markTerms(html, terms)}</svelte:element>
{#if open !== null && entries.length > 0}
  <TermTooltip {id} {entries} anchor={open.anchor} onEnter={stay} onLeave={leave} />
{/if}

<style>
  .term-text :global(.term) { text-decoration: underline dotted; text-underline-offset: 0.2em; cursor: help; border-radius: var(--m3-shape-extra-small, 4px); }
  .term-text :global(.term:focus-visible) { outline: 2px solid var(--m3c-secondary); outline-offset: 2px; }
  .term-text :global(:first-child) { margin-top: 0; }
  .term-text :global(:last-child) { margin-bottom: 0; }
</style>
