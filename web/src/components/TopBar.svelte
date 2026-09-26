<script lang="ts">
  // The top app bar: the title, the task, the connection, and Stop [user control and freedom; error prevention by
  // placement away from the prompt, an outlined button labelled "Stop task", disabled without a run; consistency
  // with the terminal: like Ctrl+C, without a confirmation, which behaviour 1 permits only where a decision is required].
  import { Button } from "m3-svelte";
  import type { RunView } from "../state.ts";

  type Props = { run: RunView | null; connection: "connecting" | "open" | "reconnecting"; onStop: (run: number) => void };
  let { run, connection, onStop }: Props = $props();
  const CONNECTION = { connecting: "connecting…", open: "connected", reconnecting: "reconnecting…" } as const;
  const running = $derived(run !== null && run.ended === null);
</script>

<header class="bar">
  <h1 class="m3-font-title-large">plan-review</h1>
  <div class="task">
    {#if run !== null}
      <span class="m3-font-body-medium project">{run.project}</span>
      <span class="m3-font-body-small summary" title={run.task}>{run.task}</span>
    {/if}
  </div>
  <span class="connection m3-font-label-medium {connection}" role="status">{CONNECTION[connection]}</span>
  <Button variant="outlined" type="button" name="stop" disabled={!running} onclick={() => run !== null && onStop(run.id)}>Stop task</Button>
</header>

<style>
  .bar { display: flex; align-items: center; gap: 1rem; padding: 0.5rem 1rem; background: var(--m3c-surface-container); box-shadow: var(--m3-elevation-2); position: relative; z-index: 1; }
  h1 { margin: 0; }
  .task { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .summary { color: var(--m3c-on-surface-variant); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .connection { padding: 0.25rem 0.75rem; border-radius: var(--m3-shape-full); background: var(--m3c-surface-container-highest); }
  .connection.reconnecting, .connection.connecting { background: var(--m3c-error-container); color: var(--m3c-on-error-container); }
</style>
