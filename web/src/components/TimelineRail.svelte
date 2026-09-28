<script lang="ts">
  // The progress of the run (decision Q3) [visibility of system status]: the phases in the order they occurred,
  // each done, active or stopped, the cycles of each review loop nested (one line each while the loop runs, one line
  // for the whole loop when it has ended; issue #14), the steps of Gather Requirements with the clarification's count
  // (issue #21), and a progress indicator while an agent works. Issue #6: the whole run, the phases ahead included, and
  // under the Implementation that carries it out the plan's stages and steps, each step's full text in a rich tooltip.
  import { AGENT_WORKING_LABEL, clarificationProgress, cycleLine, loopSummary, NO_PHASE_YET, PLAN_LIST_LABEL, PLAN_STEP_STATE_LABEL, planStepLabel, PROGRESS_HEADING, runningFor, stageHeading, TIMELINE_STATE_LABEL } from "../../../src/prompts.ts";
  import { elapsedMs } from "../time.ts";
  import { planStepState, type RoundGroup, type TimelineEntry } from "../state.ts";
  import StepTooltip from "./StepTooltip.svelte";

  /**
   * `executing`: an execution call runs, so a started step of the plan is the current one (G-R1-2). `callStartedAt`: the
   * publication time of the current call's start, which the elapsed time is measured from (issue #42).
   */
  type Props = { timeline: readonly TimelineEntry[]; busy: boolean; executing?: boolean; callStartedAt?: string | null };
  let { timeline, busy, executing = false, callStartedAt = null }: Props = $props();
  // The clock of the elapsed time: the edge of the component, ticking once per second while a call runs.
  let now = $state(Date.now());
  $effect(() => {
    if (!busy || callStartedAt === null) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  // Text glyphs, not an icon set (docs/ui-review.md): ahead and not reached are hollow, not reached muted.
  const MARK: Record<TimelineEntry["state"], string> = { done: "✓", active: "●", stopped: "■", ahead: "○", notReached: "○" };
  const LABEL = TIMELINE_STATE_LABEL;
  const STEP_MARK: Record<ReturnType<typeof planStepState>, string> = { done: "✓", current: "●", unfinished: "◐", pending: "○" };
</script>

{#snippet loops(groups: readonly RoundGroup[])}
  {#each groups as group, g (g)}
    <div class="group {group.done ? 'done' : ''}">
      {#if groups.length > 1}<span class="m3-font-label-medium">{group.heading}</span>{/if}
      <ul>
        {#if group.result === null}
          {#each group.rounds as r (r.round)}<li class="m3-font-body-small" data-cycle>{cycleLine(r.round, r.raised, r.counted)}</li>{/each}
        {:else}
          <li class="m3-font-body-small" data-summary>{loopSummary(group.rounds.length, group.corrections, group.result)}</li>
        {/if}
      </ul>
    </div>
  {/each}
{/snippet}

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
        {@render loops(entry.groups)}
        {#if entry.steps.length > 0}
          <ol class="steps">
            {#each entry.steps as step, s (s)}
              <li class="step {step.state}" data-step={step.state} aria-current={step.state === "active" ? "step" : undefined}>
                <span class="mark" aria-label={LABEL[step.state]}>{MARK[step.state]}</span>
                <span class="m3-font-label-medium" data-step-label>{step.label}</span>
                {#if step.count !== null}<span class="m3-font-body-small count" data-count>{clarificationProgress(step.count.answered, step.count.total)}</span>{/if}
                {@render loops(step.groups)}
              </li>
            {/each}
          </ol>
        {/if}
        {#if entry.plan !== null}
          <ol class="plan" aria-label={PLAN_LIST_LABEL}>
            {#each entry.plan.stages as stage (stage.number)}
              <li class="stage">
                <span class="m3-font-label-medium" data-stage>{stageHeading(stage.number, stage.title)}</span>
                <ol>
                  {#each stage.steps as step (step.id)}
                    {@const state = planStepState(entry.state, step.status, executing)}
                    <li class="plan-step {state}" data-plan-step={state} aria-current={state === "current" ? "step" : undefined}>
                      <span class="mark" aria-label={PLAN_STEP_STATE_LABEL[state]}>{STEP_MARK[state]}</span>
                      <StepTooltip key={step.id} label={planStepLabel(step.number, step.label)} text={step.text} />
                    </li>
                  {/each}
                </ol>
              </li>
            {/each}
          </ol>
        {/if}
        {#if entry.state === "active" && busy}
          <!-- Issue #42: M3's indeterminate linear progress indicator, by hand (m3-svelte has none): no value, no end. -->
          <div class="busy" data-busy>
            <div class="indeterminate" role="progressbar" aria-label={AGENT_WORKING_LABEL}><span class="active-indicator"></span></div>
            {#if callStartedAt !== null}<span class="m3-font-body-small elapsed" data-elapsed>{runningFor(elapsedMs(callStartedAt, now))}</span>{/if}
          </div>
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
  .entry.ahead { color: var(--m3c-on-surface-variant); }
  .entry.notReached { color: var(--m3c-on-surface-variant); opacity: 0.6; }
  .plan { margin: 0.25rem 0 0; }
  .stage { margin-top: 0.25rem; }
  .plan-step { position: relative; padding: 0.125rem 0 0.125rem 1.5rem; }
  .plan-step .mark { left: 0.25rem; }
  .plan-step.done { opacity: 0.8; }
  .plan-step.current { font-weight: 600; }
  .mark { position: absolute; left: 0.5rem; }
  .steps { margin: 0.25rem 0 0; }
  .step { position: relative; padding: 0.25rem 0 0.25rem 1.5rem; }
  .step .mark { left: 0.25rem; }
  .step.done { opacity: 0.8; }
  .step.stopped { color: var(--m3c-error); }
  .count { display: block; }
  .group { margin: 0.25rem 0 0 0.25rem; }
  .group.done { opacity: 0.8; }
  .muted { color: var(--m3c-on-surface-variant); }
  .busy { margin-top: 0.5rem; display: flex; flex-direction: column; gap: 0.25rem; }
  .elapsed { color: var(--m3c-on-surface-variant); font-variant-numeric: tabular-nums; }
</style>
