<script lang="ts">
  // The current agent call and its last tool use, replaced by each event [visibility of system status].
  type Props = { text: string };
  let { text }: Props = $props();
</script>

<p class="activity m3-font-body-small" aria-live="polite" data-activity>{text === "" ? "No agent is working." : text}</p>

<style>
  .activity { margin: 0; padding: 0.25rem 1rem; color: var(--m3c-on-surface-variant); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
