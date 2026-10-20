<script lang="ts">
  import ChartColumn from "@lucide/svelte/icons/chart-column";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import X from "@lucide/svelte/icons/x";
  import { closeOnEscape, previewLayout, previews, startResize } from "../lib/filePreview.svelte";
  import type { Item, TranscriptItem } from "shared/protocol";
  import { app, rpc } from "../lib/state.svelte";
  import { visualizationUrl } from "../lib/visualizations";

  /** A visualization opened larger in the right-hand panel, in the same sandbox as inline. */
  let { threadId, id }: { threadId: string; id: string } = $props();

  type Visualization = Extract<Item, { kind: "visualization" }>;
  const isThis = (candidate: TranscriptItem): candidate is Visualization => candidate.id === id && candidate.kind === "visualization";
  const loaded = $derived(app.detail?.thread.id === threadId ? app.detail.items.find(isThis) : undefined);
  // Its turn may be older than those loaded, as when the thread is reopened with the panel open.
  let fetched = $state<Visualization | undefined>();
  const unloaded = $derived(!loaded && app.detail?.thread.id === threadId && app.detail.from > 0);
  $effect(() => {
    fetched = undefined;
    if (!unloaded) return;
    const wanted = id;
    void rpc.request("items.get", { threadId, itemIds: [wanted] }).then(([found]) => {
      if (id === wanted && found && isThis(found)) fetched = found;
    }, () => undefined);
  });
  const item = $derived(loaded ?? fetched);
  const url = $derived(item ? visualizationUrl(threadId, id, item.updatedAt) : null);
  let frame: HTMLIFrameElement | undefined = $state();
</script>

<svelte:window onkeydown={(event) => closeOnEscape(threadId, event)} />

<aside class="preview" style:width="{previewLayout.width}px">
  <!-- svelte-ignore a11y_no_static_element_interactions: a pointer-only convenience; the width is also kept between visits -->
  <div class="resize" onpointerdown={startResize}></div>
  <header>
    <ChartColumn size={14} />
    <span class="title truncate" title={item?.title}>{item?.title ?? "Visualization"}</span>
    {#if url}
      <button class="ghost icon" title="Reload" onclick={() => frame && (frame.src = url)}><RefreshCw size={14} /></button>
      <a class="ghost icon button" href={url} target="_blank" rel="noreferrer" title="Open in a new tab">
        <ExternalLink size={14} />
      </a>
    {/if}
    <button class="ghost icon" title="Close (Esc)" onclick={() => delete previews[threadId]}><X size={14} /></button>
  </header>
  {#if url && item}
    <iframe bind:this={frame} src={url} title={item.title} sandbox="allow-scripts"></iframe>
  {:else}
    <p class="message muted">This visualization is not in the thread.</p>
  {/if}
</aside>

<style>
  .preview {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    border-left: 1px solid var(--border-subtle);
  }
  .resize {
    position: absolute;
    left: -3px;
    top: 0;
    bottom: 0;
    width: 6px;
    cursor: col-resize;
    z-index: 1;
  }
  .resize:hover {
    background: var(--border-strong);
  }
  header {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    height: var(--header-height);
    padding: 0 var(--space-2) 0 var(--space-3);
    border-bottom: 1px solid var(--border-subtle);
    color: var(--text-muted);
    flex-shrink: 0;
  }
  header > :global(svg) {
    flex-shrink: 0;
    margin-right: var(--space-1);
  }
  .title {
    flex: 1;
    min-width: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  a.button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-md);
    color: var(--text-secondary);
  }
  a.button:hover {
    background: var(--surface-hover);
    color: var(--text-primary);
  }
  iframe {
    flex: 1;
    min-height: 0;
    border: 0;
    /* Pages that set no background expect a white one. */
    background: #fff;
  }
  .message {
    padding: var(--space-3) var(--space-4) 0;
    font-size: var(--text-sm);
  }
</style>
