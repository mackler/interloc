<script lang="ts">
  // The prompt the run waits on [flexibility and efficiency of use: a button per fixed choice, typing where free
  // text is meaningful; consistency: each button sends exactly what the terminal would receive]. It disappears
  // when any tab has answered.
  import { Button, TextFieldOutlined, TextFieldOutlinedMultiline } from "m3-svelte";
  import type { Widget } from "../state.ts";

  // The typed text is the page's draft of this prompt (../draft.ts, finding 5): App keeps it per (incarnation, run,
  // prompt) and withdraws it with a notice when another tab answers first [error prevention].
  type Props = { widget: Widget | null; text?: string; onAnswer: (prompt: number, text: string) => void };
  let { widget, text = $bindable(""), onAnswer }: Props = $props();
  const send = (value: string) => {
    if (widget === null) return;
    text = "";
    onAnswer(widget.asked.prompt, value);
  };
  const isQuit = (label: string) => label === "Quit";
  // An input method uses Enter to accept a candidate; that Enter is not an answer (finding 6) [error prevention].
  const composing = (e: KeyboardEvent) => e.isComposing || e.keyCode === 229;
</script>

{#if widget !== null}
  <div class="prompt" role="group" aria-label="Your answer">
    <div class="choices">
      {#each widget.choices as choice, i (i)}
        <Button variant={isQuit(choice.label) ? "outlined" : i === 0 ? "filled" : "tonal"} type="button" onclick={() => send(choice.sends)}>{choice.label}</Button>
      {/each}
    </div>
    {#if widget.asked.free !== "none"}
      <!-- A persistent label and a visible Send beside the keyboard shortcut [recognition rather than recall;
           flexibility and efficiency of use: Enter for the keyboard, the button for touch and discovery]. -->
      {#if widget.asked.free === "line"}
        <TextFieldOutlined label="Your answer" name="answer" bind:value={text} onkeydown={(e: KeyboardEvent) => { if (e.key === "Enter" && !composing(e)) { e.preventDefault(); send(text); } }} />
      {:else}
        <TextFieldOutlinedMultiline label="Your message" name="answer" rows={3} bind:value={text} onkeydown={(e: KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey && !composing(e)) { e.preventDefault(); send(text); } }} />
      {/if}
      <div class="send-row">
        <p class="hint m3-font-body-small">{widget.asked.free === "line" ? "Enter sends." : "Enter sends; Shift+Enter starts a new line."}</p>
        <Button variant="filled" type="button" name="send" disabled={text === ""} onclick={() => send(text)}>Send</Button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .prompt { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.75rem; border-top: 1px solid var(--m3c-outline-variant); background: var(--m3c-surface-container); }
  .choices { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  /* The field has the full width in every window (finding 7); the hint and Send share the row below it. */
  .send-row { display: flex; gap: 0.5rem; align-items: center; justify-content: space-between; }
  .hint { margin: 0; color: var(--m3c-on-surface-variant); }
</style>
