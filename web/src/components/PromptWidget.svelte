<script lang="ts">
  // The prompt the run waits on [flexibility and efficiency of use: a button per fixed choice, typing where free
  // text is meaningful; consistency: each button sends exactly what the terminal would receive]. It disappears
  // when any tab has answered.
  // The agent's options (an interview turn's numbered answers, a relayed question's options) are cards above the fixed
  // choices, issue #12: an option can run to a paragraph, which a button's fixed height cannot hold, so each card
  // shows the whole option where it is chosen [error prevention; recognition rather than recall]. Every option looks
  // alike, none filled, because the agent's first option is not a recommended default [consistency and standards];
  // the fixed choices keep the program's primary action filled. A card is a native button that sends only the number.
  import { Button, Card, TextFieldOutlined, TextFieldOutlinedMultiline } from "m3-svelte";
  import { answerHint, HELP_ME_DECIDE, PROPOSED_ANSWERS_LABEL } from "../../../src/prompts.ts";
  import type { Widget } from "../state.ts";

  // The typed text is the page's draft of this prompt (../draft.ts, finding 5): App keeps it per (incarnation, run,
  // prompt) and withdraws it with a notice when another tab answers first [error prevention].
  // Offline (the page has stopped reconnecting, decision G-R1-1 of the defects' requirements) the prompt stays usable:
  // the socket refuses the answer with a notice, and the field keeps what was typed [user control and freedom: no
  // typed text is lost; help users recognise and recover: the page's banner and notice say why nothing is sent].
  type Props = { widget: Widget | null; text?: string; offline?: boolean; onAnswer: (prompt: number, text: string) => void };
  let { widget, text = $bindable(""), offline = false, onAnswer }: Props = $props();
  const send = (value: string) => {
    if (widget === null) return;
    if (!offline) text = "";
    onAnswer(widget.asked.prompt, value);
  };
  const isQuit = (label: string) => label === "Quit";
  // "Help me decide" is an offer beside the answer, never the answer itself: tonal wherever it stands (decision support)
  // [consistency and standards: the filled button stays the program's primary action].
  const variantOf = (label: string, i: number): "filled" | "tonal" | "outlined" => (isQuit(label) ? "outlined" : label === HELP_ME_DECIDE ? "tonal" : i === 0 ? "filled" : "tonal");
  // An input method uses Enter to accept a candidate; that Enter is not an answer (finding 6) [error prevention].
  const composing = (e: KeyboardEvent) => e.isComposing || e.keyCode === 229;
</script>

{#if widget !== null}
  <div class="prompt" role="group" aria-label="Your answer">
    {#if widget.options.length > 0}
      <div class="options m3-font-body-medium" role="group" aria-label={PROPOSED_ANSWERS_LABEL}>
        {#each widget.options as option, i (i)}
          <Card variant="outlined" onclick={() => send(option.sends)}>{option.label}</Card>
        {/each}
      </div>
    {/if}
    <div class="choices">
      {#each widget.choices as choice, i (i)}
        <Button variant={variantOf(choice.label, i)} type="button" onclick={() => send(choice.sends)}>{choice.label}</Button>
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
        <p class="hint m3-font-body-small">{answerHint(widget.asked.free === "line" ? "line" : "message")}</p>
        <Button variant="filled" type="button" name="send" disabled={text === ""} onclick={() => send(text)}>Send</Button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .prompt { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.75rem; border-top: 1px solid var(--m3c-outline-variant); background: var(--m3c-surface-container); }
  /* One card per row at every width; a card grows with its text, and a long unbroken token (a path) wraps. Several
     paragraphs scroll within the group, so that the field, Send and the fixed choices stay in a phone's window. */
  .options { display: flex; flex-direction: column; gap: 0.5rem; max-height: 25dvh; overflow-y: auto; }
  .options > :global(button) { width: 100%; min-width: 0; overflow-wrap: anywhere; }
  .choices { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  /* The field has the full width in every window (finding 7); the hint and Send share the row below it. */
  .send-row { display: flex; gap: 0.5rem; align-items: center; justify-content: space-between; }
  .hint { margin: 0; color: var(--m3c-on-surface-variant); }
</style>
