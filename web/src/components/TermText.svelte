<script lang="ts">
  // Rendered text whose terms carry their explanations (S28, issue #36): every occurrence is marked (web/src/terms.ts)
  // after sanitizing, and one TermTooltip opens on hover and on keyboard focus of an occurrence; Escape or leaving
  // closes it [recognition rather than recall: the explanation is where the word is read; help and documentation].
  import { markTerms } from "../terms.ts";
  import { TOOLTIP_GRACE_MS } from "../time.ts";
  import TermTooltip from "./TermTooltip.svelte";
  import { focusablesOf, nextFocusable } from "../focus.ts";

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
  /**
   * The mark an event concerns: for a fragment of an occurrence split by inline markup (S59), the occurrence's first
   * fragment, its focus stop, which anchors the tooltip for placement and `aria-describedby`.
   */
  const markOf = (target: EventTarget | null): HTMLElement | null => {
    const mark = target instanceof HTMLElement ? target.closest<HTMLElement>(".term") : null;
    const key = mark?.dataset.occurrence;
    return key === undefined ? mark : (mark!.closest(".term-text")?.querySelector<HTMLElement>(`.term[data-occurrence="${key}"]`) ?? mark);
  };
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
  // S42 (W2-R1-5, P3-R1-3): the tooltip is rendered after the whole text, so the natural tab order would pass it by.
  // Focus is routed as for a disclosure: Tab on an anchor whose tooltip is open enters the tooltip; Tab there leaves to
  // what follows the anchor (never back into the tooltip); Shift+Tab and Escape there return to the anchor, which then
  // does not reopen it.
  const tipElement = (): HTMLElement | null => document.getElementById(id);
  let returning: HTMLElement | null = null;
  const onFocusIn = (target: EventTarget | null) => {
    const anchor = anchorOf(target);
    if (anchor !== null && anchor === returning) {
      returning = null;
      return;
    }
    returning = null;
    show(anchor);
  };
  const onFocusOut = (e: FocusEvent) => {
    if (anchorOf(e.target) === null) return;
    const to = e.relatedTarget;
    const tip = tipElement();
    if (to instanceof Node && (to === open?.anchor || (tip !== null && tip.contains(to)))) return;
    close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") return close();
    if (e.key !== "Tab" || e.shiftKey || open === null || e.target !== open.anchor) return;
    const tip = tipElement();
    if (tip === null) return;
    e.preventDefault();
    stay();
    tip.focus();
  };
  const toAnchor = () => {
    const anchor = open?.anchor ?? null;
    close();
    if (anchor === null) return;
    returning = anchor;
    anchor.focus();
  };
  const past = (e: KeyboardEvent) => {
    const anchor = open?.anchor ?? null;
    const tip = tipElement();
    if (anchor === null || tip === null) return close();
    const target = nextFocusable(focusablesOf(document), anchor, (el) => tip.contains(el));
    if (target === null) return close();
    e.preventDefault();
    close();
    target.focus();
  };
  const leaveTip = (e: FocusEvent) => {
    const to = e.relatedTarget;
    const tip = tipElement();
    if (to instanceof Node && (to === open?.anchor || (tip !== null && tip.contains(to)))) return;
    close();
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
  onfocusin={(e: FocusEvent) => onFocusIn(e.target)}
  onfocusout={onFocusOut}
  onkeydown={onKey}>{@html markTerms(html, terms)}</svelte:element>
{#if open !== null && entries.length > 0}
  <TermTooltip {id} {entries} anchor={open.anchor} onEnter={stay} onLeave={leave} onReturn={toAnchor} onPast={past} onFocusOut={leaveTip} />
{/if}

<style>
  .term-text :global(.term) { text-decoration: underline dotted; text-underline-offset: 0.2em; cursor: help; border-radius: var(--m3-shape-extra-small, 4px); }
  .term-text :global(.term:focus-visible) { outline: 2px solid var(--m3c-secondary); outline-offset: 2px; }
  .term-text :global(:first-child) { margin-top: 0; }
  .term-text :global(:last-child) { margin-bottom: 0; }
</style>
