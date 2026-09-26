<script lang="ts">
  // Choosing the project directory by browsing [recognition rather than recall]. An M3 dialog: a list of the
  // subdirectories, ".." to go up, and Choose for the directory shown.
  import { Button, Dialog } from "m3-svelte";
  import type { Listing } from "../state.ts";

  type Props = { open: boolean; listing: Listing | null; onList: (path: string) => void; onChoose: (path: string) => void; onClose: () => void };
  let { open, listing, onList, onChoose, onClose }: Props = $props();
  const join = (dir: string, name: string): string => (dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`);
</script>

<Dialog headline="Choose the project directory" {open} onclose={onClose}>
  {#if listing === null}
    <p class="m3-font-body-medium">Reading the directory…</p>
  {:else}
    <p class="path m3-font-body-medium">{listing.path}</p>
    {#if listing.error !== null}<p class="error m3-font-body-small" role="alert">{listing.error}</p>{/if}
    <ul class="dirs">
      {#if listing.parent !== null}
        {@const parent = listing.parent}
        <li><button type="button" class="dir m3-font-body-large" data-dir=".." onclick={() => onList(parent)}>.. (up)</button></li>
      {/if}
      {#each listing.dirs as dir (dir)}
        <li><button type="button" class="dir m3-font-body-large" data-dir={dir} onclick={() => listing && onList(join(listing.path, dir))}>{dir}/</button></li>
      {/each}
    </ul>
  {/if}
  {#snippet buttons()}
    <Button variant="text" type="button" name="cancel" onclick={onClose}>Cancel</Button>
    <Button variant="filled" type="button" name="choose" disabled={listing === null || listing.error !== null} onclick={() => listing && onChoose(listing.path)}>Choose</Button>
  {/snippet}
</Dialog>

<style>
  .path { color: var(--m3c-on-surface-variant); word-break: break-all; }
  .error { color: var(--m3c-error); }
  .dirs { list-style: none; margin: 0; padding: 0; max-height: 50vh; overflow-y: auto; min-width: 20rem; }
  .dir { all: unset; box-sizing: border-box; display: block; width: 100%; padding: 0.75rem 1rem; border-radius: var(--m3-shape-small); cursor: pointer; color: var(--m3c-on-surface); }
  .dir:hover { background: color-mix(in srgb, var(--m3c-on-surface) 8%, transparent); }
  .dir:focus-visible { outline: 2px solid var(--m3c-primary); }
</style>
