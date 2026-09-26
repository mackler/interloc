<script lang="ts">
  // One chat message [match between the system and the real world: a messaging app]: the author, a heading, and
  // the body, the agents' Markdown rendered and sanitised, the program's text as it is.
  import { render } from "../markdown.ts";
  import type { Author, Message } from "../state.ts";

  type Props = { message: Message };
  let { message }: Props = $props();
  const AUTHOR: Record<Author, string> = { program: "plan-review", user: "You", codex: "Codex", claude: "Claude Code" };
</script>

<article class="message {message.author}" data-author={message.author}>
  <header class="m3-font-label-medium">{AUTHOR[message.author]}{#if message.heading !== null} · {message.heading}{/if}</header>
  {#if message.format === "markdown"}
    <div class="body markdown m3-font-body-medium">{@html render(message.body)}</div>
  {:else}
    <div class="body text m3-font-body-medium">{message.body.replace(/^\n+|\n+$/g, "")}</div>
  {/if}
</article>

<style>
  .message { max-width: 85%; padding: 0.5rem 0.875rem; border-radius: var(--m3-shape-large); margin: 0.25rem 0; overflow-wrap: anywhere; }
  .program { align-self: flex-start; background: var(--m3c-surface-container-high); color: var(--m3c-on-surface); }
  .user { align-self: flex-end; background: var(--m3c-primary-container); color: var(--m3c-on-primary-container); }
  .codex { align-self: flex-start; background: var(--m3c-tertiary-container); color: var(--m3c-on-tertiary-container); }
  .claude { align-self: flex-end; background: var(--m3c-secondary-container); color: var(--m3c-on-secondary-container); }
  header { opacity: 0.8; margin-bottom: 0.25rem; }
  .text { white-space: pre-wrap; }
  .markdown :global(pre) { overflow-x: auto; }
  .markdown :global(:first-child) { margin-top: 0; }
  .markdown :global(:last-child) { margin-bottom: 0; }
</style>
