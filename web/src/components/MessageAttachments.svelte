<script lang="ts">
  import Download from "@lucide/svelte/icons/download";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import type { Attachment } from "shared/protocol";
  import { attachmentUrl, isImage } from "../lib/attachments";
  import FileChip from "./FileChip.svelte";

  let { threadId, attachments }: { threadId: string; attachments: Attachment[] } = $props();

  let open = $state<Attachment | null>(null);
  const images = $derived(attachments.filter((each) => isImage(each.mimeType)));
  const files = $derived(attachments.filter((each) => !isImage(each.mimeType)));

  function onKeydown(event: KeyboardEvent) {
    if (open && event.key === "Escape") open = null;
  }

  /**
   * Transcript items contain their layout and paint (see ThreadView), which would trap a fixed
   * overlay inside its message, so it lives in the body while open.
   */
  function toBody(node: HTMLElement) {
    document.body.append(node);
    return () => node.remove();
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if images.length > 0}
  <div class="thumbs">
    {#each images as attachment (attachment.id)}
      <button class="thumb" title={attachment.name} onclick={() => (open = attachment)}>
        <img src={attachmentUrl(threadId, attachment.id)} alt={attachment.name} loading="lazy" />
      </button>
    {/each}
  </div>
{/if}
{#if files.length > 0}
  <!-- The server sends these as downloads under their own name; `download` says so up front. -->
  <div class="files">
    {#each files as attachment (attachment.id)}
      <a class="file" href={attachmentUrl(threadId, attachment.id)} download={attachment.name} title="Download {attachment.name}">
        <FileChip name={attachment.name} mimeType={attachment.mimeType} size={attachment.size} />
        <Download size={14} />
      </a>
    {/each}
  </div>
{/if}

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions: Escape closes it too -->
  <div class="overlay" onclick={() => (open = null)} {@attach toBody}>
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
  .files {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--space-2);
    max-width: 100%;
  }
  .file {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    max-width: min(280px, 100%);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-overlay);
    color: var(--text-muted);
    text-decoration: none;
  }
  .file:hover {
    border-color: var(--border-default);
    color: var(--text-secondary);
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
