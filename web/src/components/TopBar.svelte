<script lang="ts">
  // The top app bar: the title, the task, the connection, and Stop [user control and freedom; error prevention by
  // placement away from the prompt, an outlined button labelled "Stop task" in the error role, disabled without a run,
  // and a confirmation that says what ends and the exit code (S25, issue #25), since the run cannot be resumed].
  // Below M3's expanded width (finding 7 of docs/gui-review.md) the bar wraps: the title, the connection and Stop stay
  // on the first line, and the project and the task move to a secondary line [visibility of system status: nothing
  // that says what runs or whether the page is connected is dropped].
  import { Button } from "m3-svelte";
  import ConfirmEndDialog from "./ConfirmEndDialog.svelte";
  import type { RunView, ViewState } from "../state.ts";

  // A failed page (defect B of docs/page-question-phase-defects.md) reads "disconnected", and Stop, which can no longer
  // reach the server, is disabled [visibility of system status; error prevention].
  type Props = { run: RunView | null; connection: ViewState["connection"]; onStop: (run: number) => void };
  let { run, connection, onStop }: Props = $props();
  const CONNECTION: Record<ViewState["connection"], string> = { connecting: "connecting…", open: "connected", reconnecting: "reconnecting…", failed: "disconnected" };
  const running = $derived(run !== null && run.ended === null);
  let confirming = $state(false);
</script>

<header class="bar">
  <h1 class="m3-font-title-large">Interloq</h1>
  <div class="task">
    {#if run !== null}
      <span class="m3-font-body-medium project">{run.project}</span>
      <span class="m3-font-body-small summary" title={run.task}>{run.task}</span>
    {/if}
  </div>
  <span class="connection m3-font-label-medium {connection}" role="status">{CONNECTION[connection]}</span>
  <span class="stop"><Button variant="outlined" type="button" name="stop" disabled={!running || connection === "failed"} onclick={() => (confirming = true)}>Stop task</Button></span>
</header>
<ConfirmEndDialog ending={confirming ? "stopTask" : null} onConfirm={() => { confirming = false; if (run !== null) onStop(run.id); }} onCancel={() => (confirming = false)} />

<style>
  .bar { display: flex; align-items: center; gap: 1rem; padding: 0.5rem 1rem; background: var(--m3c-surface-container); box-shadow: var(--m3-elevation-2); position: relative; z-index: 1; }
  h1 { margin: 0; white-space: nowrap; }
  .task { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .summary { color: var(--m3c-on-surface-variant); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .stop { --m3c-primary: var(--m3c-error); --m3c-outline: var(--m3c-error); }
  .connection { padding: 0.25rem 0.75rem; border-radius: var(--m3-shape-full); background: var(--m3c-surface-container-highest); }
  @media (max-width: 839px) {
    .bar { flex-wrap: wrap; gap: 0.25rem 0.75rem; }
    h1 { flex: 1; }
    .task { order: 2; flex-basis: 100%; }
  }
  /* A compact window: M3's title size for a small top app bar (22 px), so that Stop stays on the first line. */
  @media (max-width: 599px) {
    h1 { font-size: 1.375rem; line-height: 1.75rem; }
  }
  .connection.reconnecting, .connection.connecting, .connection.failed { background: var(--m3c-error-container); color: var(--m3c-on-error-container); }
</style>
