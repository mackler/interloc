<script lang="ts">
  // The form for a new task [error prevention: Start is disabled until both fields are filled and no run is
  // active; help users recognise, diagnose and recover: the server's refusal is the field's error text;
  // recognition rather than recall: the directory browser, and the last path remembered].
  import { Button, TextFieldOutlined, TextFieldOutlinedMultiline } from "m3-svelte";

  type Props = { cwd: string; running: boolean; refused: string | null; chosen: string | null; onStart: (project: string, task: string) => void; onBrowse: (from: string) => void };
  let { cwd, running, refused, chosen, onStart, onBrowse }: Props = $props();

  const KEY = "plan-review.project";
  const remembered = (): string => (typeof localStorage === "undefined" ? "" : (localStorage.getItem(KEY) ?? ""));
  let edited = $state<string | null>(null);
  let task = $state("");
  // The directory chosen in the dialog wins, then what the user typed, then the remembered path, then the server's directory.
  const project = $derived(edited ?? chosen ?? (remembered() || cwd));
  const ready = $derived(project.trim() !== "" && task.trim() !== "" && !running);

  const start = () => {
    if (!ready) return;
    localStorage.setItem(KEY, project.trim());
    onStart(project.trim(), task.trim());
  };
  $effect(() => {
    if (chosen !== null) edited = null;
  });
</script>

<form class="start" onsubmit={(e) => { e.preventDefault(); start(); }}>
  <h2 class="m3-font-title-large">New task</h2>
  <p class="help m3-font-body-medium">
    Claude Code writes a plan, Codex reviews it until no issue remains, Claude Code implements it, and Codex reviews
    the work; the page asks you only where a decision is needed. The records are kept in the project's
    <code>plan-review/</code> directory. <strong>Stop task</strong> ends a task like Ctrl+C in the terminal.
  </p>
  <div class="row">
    <div class="field">
      <TextFieldOutlined label="Project directory" name="project" value={project} error={refused !== null} oninput={(e: Event) => (edited = (e.currentTarget as HTMLInputElement).value)} />
      {#if refused !== null}
        <p class="error m3-font-body-small" role="alert">{refused}</p>
      {:else}
        <p class="support m3-font-body-small">A git repository inside this container.</p>
      {/if}
    </div>
    <Button variant="outlined" type="button" name="browse" onclick={() => onBrowse(project)}>Browse…</Button>
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
