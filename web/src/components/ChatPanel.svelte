<script lang="ts">
  // A chat panel. New messages scroll into view unless the user has scrolled up, when a chip offers to jump to
  // them [user control and freedom: the scrolling is not taken from the user; visibility of system status].
  import { Chip } from "m3-svelte";
  import { tick, untrack } from "svelte";
  import MessageView from "./Message.svelte";
  import type { Message } from "../state.ts";

  // `visible` (P3-R1-1): a panel hidden by the compact layout stays mounted with display: none, where its list has no
  // height. While hidden it neither scrolls nor reads scroll events; shown again, it goes to its end if it was
  // following, and otherwise keeps the user's place, with the chip counting what arrived meanwhile.
  type Props = { title: string; messages: readonly Message[]; empty: string; visible?: boolean };
  let { title, messages, empty, visible = true }: Props = $props();
  let list = $state<HTMLElement | null>(null);
  let following = $state(true);
  let unseen = $state(0);
  let seen = 0;

  const atBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  const toBottom = () => {
    if (list !== null) list.scrollTop = list.scrollHeight;
    following = true;
    unseen = 0;
  };
  $effect(() => {
    const count = messages.length;
    if (count < seen) seen = 0;
    const shown = untrack(() => visible);
    if (following) {
      if (shown) queueMicrotask(toBottom);
    } else unseen += count - seen;
    seen = count;
  });
  $effect(() => {
    if (visible && untrack(() => following)) void tick().then(toBottom);
  });
</script>

<section class="panel" aria-label={title}>
  <h2 class="m3-font-title-small">{title}</h2>
  <div class="list" bind:this={list} onscroll={() => { if (list !== null && visible) { following = atBottom(list); if (following) unseen = 0; } }} aria-live="polite">
    {#if messages.length === 0}<p class="empty m3-font-body-medium">{empty}</p>{/if}
    {#each messages as message (message.key)}<MessageView {message} />{/each}
  </div>
  {#if !following && unseen > 0}
    <div class="jump"><Chip variant="assist" elevated onclick={toBottom}>{unseen} new message{unseen === 1 ? "" : "s"}</Chip></div>
  {/if}
</section>

<style>
  .panel { position: relative; display: flex; flex-direction: column; min-height: 0; min-width: 0; background: var(--m3c-surface-container-lowest); border-radius: var(--m3-shape-large); }
  h2 { margin: 0; padding: 0.75rem 1rem; color: var(--m3c-on-surface-variant); border-bottom: 1px solid var(--m3c-outline-variant); }
  .list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; padding: 0.75rem; }
  .empty { color: var(--m3c-on-surface-variant); margin: auto; }
  .jump { position: absolute; bottom: 0.75rem; left: 50%; transform: translateX(-50%); }
</style>
