<script lang="ts">
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import type { Attachment } from "shared/protocol";
  import { attachmentUrl } from "../lib/attachments";

  let { threadId, attachments }: { threadId: string; attachments: Attachment[] } = $props();

  let open = $state<Attachment | null>(null);

  function onKeydown(event: KeyboardEvent) {
    if (open && event.key === "Escape") open = null;
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="thumbs">
  {#each attachments as attachment (attachment.id)}
    <button class="thumb" title={attachment.name} onclick={() => (open = attachment)}>
      <img src={attachmentUrl(threadId, attachment.id)} alt={attachment.name} loading="lazy" />
    </button>
  {/each}
</div>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions: Escape closes it too -->
  <div class="overlay" onclick={() => (open = null)}>
    <img src={attachmentUrl(threadId, open.id)} alt={open.name} />
    <a
      class="new-tab"
      href={attachmentUrl(threadId, open.id)}
      target="_blank"
      rel="noopener"
      onclick={(event) => event.stopPropagation()}
    >
      <ExternalLink size={12} />{open.name}
    </a>
  </div>
{/if}

<style>
  .thumbs {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--space-2);
  }
  .thumb {
    width: 96px;
    height: 96px;
    padding: 0;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    overflow: hidden;
    background: var(--surface-overlay);
    cursor: zoom-in;
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    padding: var(--space-8);
    background: rgb(0 0 0 / 0.8);
    cursor: zoom-out;
    white-space: normal;
  }
  .overlay img {
    max-width: 100%;
    max-height: calc(100% - 2em);
    object-fit: contain;
  }
  .new-tab {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
</style>
