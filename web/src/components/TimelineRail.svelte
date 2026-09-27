<script lang="ts">
  // The progress of the run (decision Q3) [visibility of system status]: the phases in the order they occurred,
  // each done, active or stopped, the cycles of each review loop nested (one line each while the loop runs, one line
  // for the whole loop when it has ended; issue #14), and a progress indicator while an agent works.
  import { LinearProgressEstimate } from "m3-svelte";
  import { cycleLine, loopSummary, NO_PHASE_YET, PROGRESS_HEADING } from "../../../src/prompts.ts";
  import type { TimelineEntry } from "../state.ts";

  type Props = { timeline: readonly TimelineEntry[]; busy: boolean };
  let { timeline, busy }: Props = $props();
  const MARK: Record<TimelineEntry["state"], string> = { done: "✓", active: "●", stopped: "■" };
  const LABEL: Record<TimelineEntry["state"], string> = { done: "done", active: "in progress", stopped: "stopped" };
</script>

<nav class="rail" aria-label="Progress of the run">
  <h2 class="m3-font-title-small">{PROGRESS_HEADING}</h2>
  {#if timeline.length === 0}
    <p class="m3-font-body-small muted">{NO_PHASE_YET}</p>
  {/if}
  <ol>
    {#each timeline as entry, i (i)}
      <li class="entry {entry.state}" data-state={entry.state} aria-current={entry.state === "active" ? "step" : undefined}>
        <span class="mark" aria-label={LABEL[entry.state]}>{MARK[entry.state]}</span>
        <span class="m3-font-label-large" data-label>{entry.label}</span>
        {#each entry.groups as group, g (g)}
          <div class="group {group.done ? 'done' : ''}">
            {#if entry.groups.length > 1}<span class="m3-font-label-medium">{group.heading}</span>{/if}
            <ul>
              {#if group.result === null}
                {#each group.rounds as r (r.round)}<li class="m3-font-body-small" data-cycle>{cycleLine(r.round, r.raised, r.counted)}</li>{/each}
              {:else}
                <li class="m3-font-body-small" data-summary>{loopSummary(group.rounds.length, group.corrections, group.result)}</li>
              {/if}
            </ul>
          </div>
        {/each}
        {#if entry.state === "active" && busy}
          <div class="busy" data-busy><LinearProgressEstimate aria-label="An agent is working" /></div>
        {/if}
      </li>
    {/each}
  </ol>
</nav>

<style>
  .rail { padding: 1rem 0.75rem; overflow-y: auto; }
  h2 { margin: 0 0 0.75rem; color: var(--m3c-on-surface-variant); }
  ol, ul { list-style: none; margin: 0; padding: 0; }
  .entry { position: relative; padding: 0.5rem 0.5rem 0.5rem 1.75rem; border-radius: var(--m3-shape-medium); }
  .entry.active { background: var(--m3c-secondary-container); color: var(--m3c-on-secondary-container); }
  .entry.done { color: var(--m3c-on-surface-variant); }
  .entry.stopped { color: var(--m3c-error); }
  .mark { position: absolute; left: 0.5rem; }
  .group { margin: 0.25rem 0 0 0.25rem; }
  .group.done { opacity: 0.8; }
  .muted { color: var(--m3c-on-surface-variant); }
  .busy { margin-top: 0.5rem; }
</style>
