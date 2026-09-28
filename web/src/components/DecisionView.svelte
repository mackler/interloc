<script lang="ts">
  // The analysis of a decision (decision support), over both chat columns until the question is answered.
  // One column per option, as docs/decision-making.md requires ("Layout and wording"), side by side at a minimum
  // readable width of 20rem (about 45 characters of body text) and scrolling sideways when they do not fit (decision
  // Q5) [aesthetic and minimalist design: nothing is squeezed to unreadable widths; match between the system and the
  // real world: it reads as prose, in columns as on paper]; each column names its option at its head [recognition
  // rather than recall], and a line says when columns lie outside the window [visibility of system status]. Each
  // counterargument is offset under the element it disputes, one step per level, with a rule on its left; the heading
  // "Disadvantages:" and the equivalence symbols come from src/analysisView.ts. Below 390 px nothing is laid out and a
  // message asks for a wider window; the prompt below stays usable [help users recognize and recover]. The
  // conversation is one click away and back [user control and freedom].
  import { Button } from "m3-svelte";
  import { decisionViewHeading, ENLARGE_WINDOW_NOTICE, recommendedOption, RECOMMENDATION_HEADING, SCROLL_SIDEWAYS_HINT, SHOW_CONVERSATION } from "../../../src/prompts.ts";
  import { type EntryView, viewOf } from "../../../src/analysisView.ts";
  import type { UiEvent } from "../../../src/uiEvents.ts";

  type Props = { event: Extract<UiEvent, { _tag: "DecisionAnalyzed" }>; narrow: boolean; onShowConversation: () => void };
  let { event, narrow, onShowConversation }: Props = $props();
  const view = $derived(viewOf(event.analysis));
  let row = $state<HTMLElement | null>(null);
  let overflowing = $state(false);
  const measure = () => {
    if (row !== null) overflowing = row.scrollWidth > row.clientWidth + 1;
  };
  $effect(() => {
    void view;
    measure();
  });
  const marked = (text: string, symbol: string | null) => (symbol === null ? text : `${text} ${symbol}`);
</script>

<svelte:window onresize={measure} />
{#snippet entryOf(entry: EntryView)}
  <div class="entry">
    <p class="title m3-font-title-small">{marked(entry.title, entry.symbol)}</p>
    <ul class="elements">
      {#each entry.elements as element, i (i)}
        <li class="element">
          <span>{element.text}</span>
          {#if element.arguments.length > 0}
            <ul class="arguments">
              {#each element.arguments as argument (argument.id)}
                <li class="argument" data-level={argument.level} style:margin-left="{(argument.level - 1) * 1.25}rem">{marked(argument.text, argument.symbol)}</li>
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
{/snippet}

<section class="decision" aria-label={decisionViewHeading(event.decision, event.question)}>
  <div class="head">
    <h2 class="m3-font-title-medium">{decisionViewHeading(event.decision, event.question)}</h2>
    <Button variant="tonal" type="button" name="conversation" onclick={onShowConversation}>{SHOW_CONVERSATION}</Button>
  </div>
  {#if narrow}
    <p class="narrow m3-font-body-medium" role="alert">{ENLARGE_WINDOW_NOTICE}</p>
  {:else}
    {#if overflowing}<p class="hint m3-font-body-small">{SCROLL_SIDEWAYS_HINT}</p>{/if}
    <div class="columns" bind:this={row} style:grid-template-columns="repeat({view.columns.length}, minmax(20rem, 1fr))">
      {#each view.columns as column, i (i)}
        <article class="column m3-font-body-medium">
          <h3 class="m3-font-title-medium">{column.option}</h3>
          {#each column.advantages as entry (entry.id)}{@render entryOf(entry)}{/each}
          <h4 class="disadvantages-heading m3-font-title-small">{column.disadvantagesHeading}</h4>
          {#each column.disadvantages as entry (entry.id)}{@render entryOf(entry)}{/each}
        </article>
      {/each}
    </div>
    {#if view.recommendation !== null}
      <section class="recommendation m3-font-body-medium" aria-label={RECOMMENDATION_HEADING}>
        <h3 class="m3-font-title-small">{recommendedOption(view.recommendation.option)}</h3>
        <p>{view.recommendation.reason}</p>
      </section>
    {/if}
  {/if}
</section>

<style>
  .decision { display: flex; flex-direction: column; gap: 0.5rem; flex: 1; min-height: 0; min-width: 0; overflow: hidden; padding: 0.75rem; border-radius: var(--m3-shape-medium); background: var(--m3c-surface-container-lowest); }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; }
  .head h2 { margin: 0; }
  .hint, .narrow { margin: 0; color: var(--m3c-on-surface-variant); }
  /* The row of columns scrolls in both directions within the area, so that the question and the prompt stay in view. */
  .columns { display: grid; gap: 0.75rem; flex: 1; min-height: 0; overflow: auto; align-items: start; }
  .column { padding: 0.75rem; border-radius: var(--m3-shape-medium); background: var(--m3c-surface-container); user-select: text; }
  .column h3 { margin: 0 0 0.5rem; position: sticky; top: 0; background: inherit; }
  .disadvantages-heading { margin: 1rem 0 0.5rem; }
  .entry { margin-bottom: 0.75rem; }
  .title { margin: 0 0 0.25rem; }
  .elements { margin: 0; padding-left: 1.25rem; }
  .element { margin-bottom: 0.25rem; }
  .arguments { list-style: none; margin: 0.25rem 0 0.25rem 0.5rem; padding: 0; }
  .argument { margin-top: 0.25rem; padding-left: 0.5rem; border-left: 2px solid var(--m3c-outline-variant); color: var(--m3c-on-surface-variant); }
  .recommendation { padding: 0.75rem; border-radius: var(--m3-shape-medium); background: var(--m3c-secondary-container); color: var(--m3c-on-secondary-container); }
  .recommendation h3, .recommendation p { margin: 0; }
</style>
