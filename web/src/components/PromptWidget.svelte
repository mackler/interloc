<script lang="ts">
  // The prompt the run waits on [flexibility and efficiency of use: a button per fixed choice, typing where free
  // text is meaningful; consistency: each button sends exactly what the terminal would receive]. It disappears
  // when any tab has answered.
  import { Button } from "m3-svelte";
  import type { Widget } from "../state.ts";

  type Props = { widget: Widget | null; onAnswer: (prompt: number, text: string) => void };
  let { widget, onAnswer }: Props = $props();
  let text = $state("");
  const send = (value: string) => {
    if (widget === null) return;
    onAnswer(widget.asked.prompt, value);
    text = "";
  };
  const isQuit = (label: string) => label === "Quit";
</script>

{#if widget !== null}
  <div class="prompt" role="group" aria-label="Your answer">
    <div class="choices">
      {#each widget.choices as choice, i (i)}
        <Button variant={isQuit(choice.label) ? "outlined" : i === 0 ? "filled" : "tonal"} type="button" onclick={() => send(choice.sends)}>{choice.label}</Button>
      {/each}
    </div>
    {#if widget.asked.free === "line"}
      <input class="free m3-font-body-large" name="answer" placeholder="Or type your answer, then Enter" bind:value={text} onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); send(text); } }} />
    {:else if widget.asked.free === "message"}
      <textarea class="free m3-font-body-large" name="answer" rows="3" placeholder="Your message — Enter sends, Shift+Enter starts a new line" bind:value={text} onkeydown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); } }}></textarea>
    {/if}
  </div>
{/if}

<style>
  .prompt { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.75rem; border-top: 1px solid var(--m3c-outline-variant); background: var(--m3c-surface-container); }
  .choices { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .free { box-sizing: border-box; width: 100%; padding: 0.75rem 1rem; border: 1px solid var(--m3c-outline); border-radius: var(--m3-shape-extra-small); background: var(--m3c-surface); color: var(--m3c-on-surface); resize: vertical; }
  .free:focus { outline: 2px solid var(--m3c-primary); border-color: transparent; }
</style>
