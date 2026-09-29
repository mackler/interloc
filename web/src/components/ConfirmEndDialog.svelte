<script lang="ts">
  // The confirmation before a run ends (S25, issue #25) [error prevention: an ending that cannot be undone is confirmed;
  // user control and freedom: Cancel returns to the question with nothing lost; visibility of system status: the text
  // says what ends, that the records remain, and the exit code]. The confirming button uses the error role, the
  // destructive action of M3; Cancel is a text button.
  import { Button, Dialog } from "m3-svelte";
  import { CANCEL_END, confirmEndAction, confirmEndHeadline, confirmEndText } from "../../../src/prompts.ts";

  type Ending = "endRun" | "stopTask" | "limitStop";
  type Props = { ending: Ending | null; onConfirm: () => void; onCancel: () => void };
  let { ending, onConfirm, onCancel }: Props = $props();
</script>

<Dialog headline={ending === null ? "" : confirmEndHeadline(ending)} open={ending !== null} onclose={onCancel}>
  {#if ending !== null}<p class="m3-font-body-medium">{confirmEndText(ending)}</p>{/if}
  {#snippet buttons()}
    <Button variant="text" type="button" name="cancel-end" onclick={onCancel}>{CANCEL_END}</Button>
    <div class="destructive"><Button variant="filled" type="button" name="confirm-end" onclick={onConfirm}>{ending === null ? "" : confirmEndAction(ending)}</Button></div>
  {/snippet}
</Dialog>

<style>
  .destructive { display: contents; --m3c-primary: var(--m3c-error); --m3c-on-primary: var(--m3c-on-error); }
</style>
