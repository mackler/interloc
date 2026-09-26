<script lang="ts">
  // The page (decision Q3 layout) [consistency and standards: one top app bar, M3 layout regions; the page shows
  // only the newest run, in progress or ended, and offers a new task when it has ended].
  // Adaptive layout (finding 7 of docs/gui-review.md, decision Q3 of its task): at M3's expanded width the rail and the
  // two panels stand side by side; below it the rail becomes a one-line disclosure and one panel is shown at a time,
  // chosen by its title in a segmented group [aesthetic and minimalist design: nothing is squeezed to unreadable
  // widths; visibility of system status: the current phase stays in view and a badge counts the hidden panel's new
  // messages; user control: the user chooses the panel, and only a new prompt, which is answered in "You and
  // plan-review", selects it].
  import { Button, ConnectedButtons } from "m3-svelte";
  import { untrack } from "svelte";
  import { progressLine, unseenBadge } from "../../../src/prompts.ts";
  import { EXPANDED_MIN_WIDTH, initialLayout, type Layout, observe, type Pane, select } from "../layout.ts";
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

  let width = $state(typeof window === "undefined" ? EXPANDED_MIN_WIDTH : window.innerWidth);
  const compact = $derived(width < EXPANDED_MIN_WIDTH);
  let layout = $state<Layout>(initialLayout);
  $effect(() => {
    const counts = { left: view.run?.left.length ?? 0, right: view.run?.right.length ?? 0 };
    const prompt = pendingKey(view);
    const narrow = compact;
    layout = observe(untrack(() => layout), { counts, prompt }, narrow);
  });
  /** Whether a column is shown: both at expanded width, the selected one below it. */
  const shown = (pane: Pane): boolean => !compact || layout.selected === pane;
  const TITLES: Record<Pane, string> = { left: "You and plan-review", right: "Claude Code and Codex" };
  /** The one-line progress of a compact window: the current phase and its latest round (the text: src/prompts.ts). */
  const progressOf = (r: NonNullable<ViewState["run"]>): string => {
    const entry = [...r.timeline].reverse().find((e) => e.state === "active") ?? r.timeline[r.timeline.length - 1];
    if (entry === undefined) return progressLine(null, null);
    const rounds = entry.groups[entry.groups.length - 1]?.rounds ?? [];
    return progressLine(entry.label, rounds[rounds.length - 1] ?? null);
  };

  const run = $derived(view.run);
  const showForm = $derived(run === null || (run.ended !== null && formWanted));
  const latestNotice = $derived(view.notices.length > noticesSeen ? view.notices[view.notices.length - 1] : null);
  const refused = $derived(showForm ? latestNotice : null);
</script>

<svelte:window bind:innerWidth={width} />
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
    <!-- One tree for both layouts (W2-R1-3): the columns stay mounted, and CSS alone shows or hides them, so a switch
         of panels or a resize across 840 px keeps each panel's reading position [user control and freedom]. -->
    <main class="run" class:compact>
      {#if compact}
        <details class="progress">
          <Button summary variant="text">{progressOf(run)}</Button>
          <TimelineRail timeline={run.timeline} busy={run.busy} />
        </details>
        <ConnectedButtons>
          {#each ["left", "right"] as const as pane (pane)}
            <Button variant={layout.selected === pane ? "filled" : "tonal"} type="button" aria-pressed={layout.selected === pane} onclick={() => (layout = select(layout, pane))}>
              {TITLES[pane]}{#if layout.unseen[pane] > 0}<span class="badge">&nbsp;{unseenBadge(layout.unseen[pane])}</span>{/if}
            </Button>
          {/each}
        </ConnectedButtons>
        <!-- The latest notice above the panels, whichever is shown (W2-R1-2) [visibility of system status]. -->
        {#if latestNotice !== null}<p class="notice m3-font-body-small" role="alert">{latestNotice}</p>{/if}
      {:else}
        <TimelineRail timeline={run.timeline} busy={run.busy} />
      {/if}
      <div class="left" class:hidden={!shown("left")}>
        <ChatPanel title={TITLES.left} messages={run.left} empty="The run has started." visible={shown("left")} />
        <PromptWidget
          widget={run.pending}
          bind:text={() => draftFor(draft, pendingKey(view)), (text) => { const key = pendingKey(view); draft = key === null ? null : { key, text }; }}
          onAnswer={(prompt, text) => send({ type: "answer", incarnation: view.incarnation ?? "", run: run.id, prompt, text })} />
        {#if !compact && latestNotice !== null}<p class="notice m3-font-body-small" role="alert">{latestNotice}</p>{/if}
        {#if run.ended !== null}
          <div class="ended">
            <span class="m3-font-body-medium">This task has ended ({run.ended === 0 ? "finished" : run.ended === 130 ? "interrupted" : "halted"}).</span>
            <Button variant="filled" type="button" name="new" onclick={() => { formWanted = true; noticesSeen = view.notices.length; }}>New task</Button>
          </div>
        {/if}
      </div>
      <div class="right" class:hidden={!shown("right")}>
        <ChatPanel title={TITLES.right} messages={run.right} empty="No review yet." visible={shown("right")} />
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
  .run.compact { display: flex; flex-direction: column; gap: 0.5rem; overflow-y: auto; }
  .run.compact > :global(*) { flex-shrink: 0; }
  .hidden { display: none; }
  /* The shown column fills the window; its panel scrolls inside it and keeps at least 12.5rem, below which the page scrolls. */
  .run.compact .left, .run.compact .right { flex: 1 0 0; }
  .run.compact .left :global(.panel), .run.compact .right :global(.panel) { min-height: 12.5rem; }
  .progress { border-radius: var(--m3-shape-medium); background: var(--m3c-surface-container-low); }
  .progress :global(.rail) { max-height: 40vh; }
  .badge { font-weight: 700; }
  .ended { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.75rem; background: var(--m3c-surface-container); }
  .notice { margin: 0; padding: 0.5rem 0.75rem; color: var(--m3c-on-error-container); background: var(--m3c-error-container); }
</style>
