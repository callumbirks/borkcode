<script lang="ts">
  import ChartColumn from "@lucide/svelte/icons/chart-column";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import PanelRightOpen from "@lucide/svelte/icons/panel-right-open";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import { previews } from "../lib/filePreview.svelte";
  import { FRAME_HEIGHT, reportedHeight, visualizationUrl } from "../lib/visualizations";

  /**
   * HTML the agent showed, inline in the transcript. The frame is sandboxed without
   * `allow-same-origin`, so the page runs in an opaque origin and cannot touch borkcode.
   */
  let { threadId, id, title, updatedAt }: { threadId: string; id: string; title: string; updatedAt: number } =
    $props();

  const url = $derived(visualizationUrl(threadId, id, updatedAt));
  let frame: HTMLIFrameElement | undefined = $state();
  let height = $state(FRAME_HEIGHT.initial);

  /** Pages report their height; only messages from this card's own frame count. */
  function onMessage(event: MessageEvent) {
    if (!frame || event.source !== frame.contentWindow) return;
    const reported = reportedHeight(event.data);
    if (reported !== null) height = reported;
  }
</script>

<svelte:window onmessage={onMessage} />

<figure class="visualization">
  <figcaption>
    <ChartColumn size={14} />
    <span class="title truncate" {title}>{title}</span>
    <!-- Setting src again reloads the frame; a page shown from a file then shows its edits. -->
    <button class="ghost icon" title="Reload" onclick={() => frame && (frame.src = url)}><RefreshCw size={14} /></button>
    <button class="ghost icon" title="Open in the side panel" onclick={() => (previews[threadId] = { visualization: id })}>
      <PanelRightOpen size={14} />
    </button>
    <a class="ghost icon button" href={url} target="_blank" rel="noreferrer" title="Open in a new tab">
      <ExternalLink size={14} />
    </a>
  </figcaption>
  <iframe bind:this={frame} src={url} {title} sandbox="allow-scripts" loading="lazy" style:height="{height}px"></iframe>
</figure>

<style>
  .visualization {
    margin: 0;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  figcaption {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-1) var(--space-1) var(--space-3);
    border-bottom: 1px solid var(--border-subtle);
    background: var(--surface-raised);
    color: var(--text-muted);
  }
  figcaption > :global(svg) {
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
    display: block;
    width: 100%;
    border: 0;
    /* Pages that set no background expect a white one. */
    background: #fff;
  }
</style>
