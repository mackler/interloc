<script lang="ts">
  // Issue #42: M3's indeterminate linear progress indicator, by hand (m3-svelte has none): no value, no end. It asserts
  // only that the program is busy, never how much remains. The rail and the activity line share it (W1-R1-4).
  type Props = { label: string };
  let { label }: Props = $props();
</script>

<div class="indeterminate" role="progressbar" aria-label={label}><span class="active-indicator"></span></div>
