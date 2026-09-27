<script lang="ts">
  // The form for a new task [error prevention: Start is disabled until both fields are filled and no run is
  // active; help users recognise, diagnose and recover: the server's refusal is the field's error text;
  // recognition rather than recall: the directory browser, and the last path remembered].
  import { Button, TextFieldOutlined, TextFieldOutlinedMultiline } from "m3-svelte";
  import { START_FORM_DESCRIPTION } from "../../../src/prompts.ts";
  import { readRemembered, remember } from "../storage.ts";

  // Offline (the page has stopped reconnecting) Start and Browse… cannot reach the server and are disabled; the fields
  // stay editable and keep their text [error prevention; user control and freedom].
  type Props = { cwd: string; running: boolean; refused: string | null; chosen: string | null; offline?: boolean; onStart: (project: string, task: string) => void; onBrowse: (from: string) => void };
  let { cwd, running, refused, chosen, offline = false, onStart, onBrowse }: Props = $props();

  // The storage is an edge (../storage.ts): a failing read falls back to the server's directory, a failing write
  // does not stop Start [error prevention: remembering is a convenience, never a prerequisite].
  const read = readRemembered();
  const remembered = (): string => (read.ok ? read.value : "");
  let edited = $state<string | null>(null);
  let task = $state("");
  // The directory chosen in the dialog wins, then what the user typed, then the remembered path, then the server's directory.
  const project = $derived(edited ?? chosen ?? (remembered() || cwd));
  const ready = $derived(project.trim() !== "" && task.trim() !== "" && !running && !offline);

  const start = () => {
    if (!ready) return;
    remember(project.trim());
    onStart(project.trim(), task.trim());
  };
  $effect(() => {
    if (chosen !== null) edited = null;
  });
</script>

<form class="start" onsubmit={(e) => { e.preventDefault(); start(); }}>
  <h2 class="m3-font-title-large">New task</h2>
  <p class="help m3-font-body-medium">{#each START_FORM_DESCRIPTION as part}{#if part.style === "code"}<code>{part.text}</code>{:else if part.style === "strong"}<strong>{part.text}</strong>{:else}{part.text}{/if}{/each}</p>
  <div class="row">
    <div class="field">
      <TextFieldOutlined label="Project directory" name="project" value={project} error={refused !== null} oninput={(e: Event) => (edited = (e.currentTarget as HTMLInputElement).value)} />
      {#if refused !== null}
        <p class="error m3-font-body-small" role="alert">{refused}</p>
      {:else}
        <p class="support m3-font-body-small">A git repository inside this container.</p>
      {/if}
    </div>
    <Button variant="outlined" type="button" name="browse" disabled={offline} onclick={() => onBrowse(project)}>Browse…</Button>
  </div>
  <TextFieldOutlinedMultiline label="Task" name="task" bind:value={task} rows={6} />
  <div class="actions">
    <Button variant="filled" type="submit" name="start" disabled={!ready}>Start</Button>
    {#if running}<span class="m3-font-body-medium support">A task is running; it must end before a new one starts.</span>{/if}
  </div>
</form>

<style>
  .start { display: flex; flex-direction: column; gap: 1rem; max-width: 48rem; margin: 2rem auto; padding: 1.5rem; border-radius: var(--m3-shape-large); background: var(--m3c-surface-container-low); }
  .row { display: flex; gap: 0.75rem; align-items: flex-start; }
  .field { flex: 1; display: flex; flex-direction: column; }
  .error { color: var(--m3c-error); margin: 0.25rem 1rem 0; }
  .support { color: var(--m3c-on-surface-variant); margin: 0.25rem 1rem 0; }
  .actions { display: flex; gap: 1rem; align-items: center; }
  h2 { margin: 0; }
  .help { margin: 0; color: var(--m3c-on-surface-variant); }
</style>
