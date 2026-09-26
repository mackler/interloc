<script lang="ts">
  // The page (decision Q3 layout) [consistency and standards: one top app bar, M3 layout regions; the page shows
  // only the newest run, in progress or ended, and offers a new task when it has ended].
  import { Button } from "m3-svelte";
  import type { ClientMessage } from "../../../src/protocol.ts";
  import { type Draft, draftFor, pendingKey, reconcile } from "../draft.ts";
  import { connect, type Connection } from "../socket.ts";
  import { initialState, notice, reduce, type ViewState } from "../state.ts";
  import ActivityLine from "./ActivityLine.svelte";
  import ChatPanel from "./ChatPanel.svelte";
  import DirectoryDialog from "./DirectoryDialog.svelte";
  import PromptWidget from "./PromptWidget.svelte";
  import StartForm from "./StartForm.svelte";
  import TimelineRail from "./TimelineRail.svelte";
  import TopBar from "./TopBar.svelte";

  let view = $state<ViewState>(initialState);
  let connection: Connection | null = null;
  let browsing = $state(false);
  let chosen = $state<string | null>(null);
  // After a run has ended, the form is shown again once the user asks for a new task.
  let formWanted = $state(false);
  let noticesSeen = $state(0);
  // The unsent text of the pending prompt (finding 5), reconciled with the view after every message, live or replayed.
  let draft = $state<Draft | null>(null);

  const send = (m: ClientMessage) => connection?.send(m);
  $effect(() => {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    connection = connect(url, {
      onMessage: (m) => {
        view = reduce(view, m);
        const reconciled = reconcile(draft, view);
        draft = reconciled.draft;
        if (reconciled.notice !== null) view = notice(view, reconciled.notice);
        if (m.type === "event" && m.event._tag === "Started") formWanted = false;
        if (view.needsReconnect) connection?.reconnect();
      },
      onState: (s) => (view = { ...view, connection: s }),
      onNotice: (t) => (view = notice(view, t)),
    });
    return () => connection?.close();
  });

  const run = $derived(view.run);
  const showForm = $derived(run === null || (run.ended !== null && formWanted));
  const latestNotice = $derived(view.notices.length > noticesSeen ? view.notices[view.notices.length - 1] : null);
  const refused = $derived(showForm ? latestNotice : null);
</script>

<div class="app">
  <TopBar {run} connection={view.connection} onStop={(id) => send({ type: "stop", incarnation: view.incarnation ?? "", run: id })} />
  {#if showForm}
    <main class="form">
      <StartForm
        cwd={view.cwd}
        running={view.current !== null}
        {refused}
        {chosen}
        onStart={(project, task) => { noticesSeen = view.notices.length; send({ type: "start", project, task }); }}
        onBrowse={(from) => { browsing = true; send({ type: "list", path: from || view.cwd }); }}
      />
    </main>
  {:else if run !== null}
    <main class="run">
      <TimelineRail timeline={run.timeline} busy={run.busy} />
      <div class="left">
        <ChatPanel title="You and plan-review" messages={run.left} empty="The run has started." />
        <PromptWidget
          widget={run.pending}
          bind:text={() => draftFor(draft, pendingKey(view)), (text) => { const key = pendingKey(view); draft = key === null ? null : { key, text }; }}
          onAnswer={(prompt, text) => send({ type: "answer", incarnation: view.incarnation ?? "", run: run.id, prompt, text })} />
        {#if latestNotice !== null}<p class="notice m3-font-body-small" role="alert">{latestNotice}</p>{/if}
        {#if run.ended !== null}
          <div class="ended">
            <span class="m3-font-body-medium">This task has ended ({run.ended === 0 ? "finished" : run.ended === 130 ? "interrupted" : "halted"}).</span>
            <Button variant="filled" type="button" name="new" onclick={() => { formWanted = true; noticesSeen = view.notices.length; }}>New task</Button>
          </div>
        {/if}
      </div>
      <div class="right">
        <ChatPanel title="Claude Code and Codex" messages={run.right} empty="No review yet." />
        <ActivityLine text={run.activity} />
      </div>
    </main>
  {/if}
  <DirectoryDialog open={browsing} listing={view.listing} onList={(path) => send({ type: "list", path })} onChoose={(path) => { chosen = path; browsing = false; }} onClose={() => (browsing = false)} />
</div>

<style>
  .app { height: 100vh; display: flex; flex-direction: column; background: var(--m3c-surface); color: var(--m3c-on-surface); }
  .form { flex: 1; overflow-y: auto; padding: 0 1rem; }
  .run { flex: 1; min-height: 0; display: grid; grid-template-columns: 14rem 1fr 1fr; gap: 0.75rem; padding: 0.75rem; }
  .left, .right { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .left :global(.panel), .right :global(.panel) { flex: 1; }
  .ended { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.75rem; background: var(--m3c-surface-container); }
  .notice { margin: 0; padding: 0.5rem 0.75rem; color: var(--m3c-on-error-container); background: var(--m3c-error-container); }
</style>
