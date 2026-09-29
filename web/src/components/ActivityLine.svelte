<script lang="ts">
  // The current agent call and its last tool use, replaced by each event [visibility of system status]; while the program
  // waits to retry a call (issue #26, W1-R1-4), the indeterminate indicator beside it: busy, with no value and no estimate.
  import Indeterminate from "./Indeterminate.svelte";
  import { RETRY_WAITING_LABEL } from "../../../src/prompts.ts";
  type Props = { text: string; busy?: boolean };
  let { text, busy = false }: Props = $props();
</script>

<div class="line">
  <p class="activity m3-font-body-small" aria-live="polite" data-activity>{text === "" ? "No agent is working." : text}</p>
  {#if busy}<div class="waiting" data-waiting><Indeterminate label={RETRY_WAITING_LABEL} /></div>{/if}
</div>

<style>
  .line { display: flex; align-items: center; gap: 0.5rem; padding: 0.25rem 1rem; }
  .activity { margin: 0; flex: 1 1 auto; min-width: 0; color: var(--m3c-on-surface-variant); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .waiting { flex: 0 0 6rem; }
</style>
