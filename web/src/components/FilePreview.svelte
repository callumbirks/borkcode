<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import Copy from "@lucide/svelte/icons/copy";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import FileText from "@lucide/svelte/icons/file-text";
  import Folder from "@lucide/svelte/icons/folder";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import X from "@lucide/svelte/icons/x";
  import DOMPurify from "dompurify";
  import { tick } from "svelte";
  import type { FileTarget } from "shared/protocol";
  import { fileUrl, formatLines, targetLabel, type PreviewTarget } from "../lib/fileLinks";
  import { closeOnEscape, previewLayout, previews, startResize } from "../lib/filePreview.svelte";
  import { renderMarkdown } from "../lib/markdown";
  import { app } from "../lib/state.svelte";

  /** The right-hand panel that shows a file or folder of the thread, read over HTTP from the server. */
  let { threadId, target }: { threadId: string; target: PreviewTarget } = $props();

  type Content =
    | { kind: "text"; text: string; fullSize: number | null }
    | { kind: "image"; url: string }
    | { kind: "directory"; entries: { name: string; kind: FileTarget["kind"] }[] };

  let content = $state<Content | null>(null);
  let error = $state("");
  let loading = $state(false);
  let raw = $state(false);
  let copied = $state(false);
  let body: HTMLDivElement | undefined = $state();

  const label = $derived(targetLabel(target));
  const isMarkdown = $derived(/\.(md|markdown)$/i.test(target.path));
  const lines = $derived(content?.kind === "text" ? content.text.replace(/\n$/, "").split("\n") : []);

  let loaded = 0;
  async function load() {
    const request = ++loaded;
    const { root, path } = target;
    loading = true;
    error = "";
    try {
      const response = await fetch(fileUrl(threadId, { root, path }));
      if (!response.ok) {
        const reason = await response.json().catch(() => null);
        throw new Error(reason?.error ?? `Could not open ${path}`);
      }
      const type = response.headers.get("content-type") ?? "";
      let next: Content;
      if (response.headers.get("x-file-kind") === "directory") {
        next = { kind: "directory", entries: (await response.json()).entries };
      } else if (type.startsWith("image/")) {
        next = { kind: "image", url: URL.createObjectURL(await response.blob()) };
      } else {
        const fullSize = response.headers.get("x-file-truncated");
        next = { kind: "text", text: await response.text(), fullSize: fullSize ? Number(fullSize) : null };
      }
      if (request !== loaded) return;
      release();
      content = next;
    } catch (cause) {
      if (request !== loaded) return;
      release();
      content = null;
      error = (cause as Error).message;
    } finally {
      if (request === loaded) loading = false;
    }
  }

  function release() {
    if (content?.kind === "image") URL.revokeObjectURL(content.url);
  }

  // Reload whenever a different file opens, and show lines raw so they can be highlighted.
  $effect(() => {
    void [threadId, target.root, target.path];
    raw = target.lines !== null;
    void load();
    return release;
  });

  // Scroll the asked-for lines into view once they render.
  $effect(() => {
    if (!target.lines || content?.kind !== "text" || (isMarkdown && !raw)) return;
    const start = target.lines.start;
    void tick().then(() => body?.querySelector(`[data-line="${start}"]`)?.scrollIntoView({ block: "center" }));
  });

  function close() {
    delete previews[threadId];
  }

  function open(path: string) {
    previews[threadId] = { root: target.root, path, lines: null };
  }

  function parentPath(path: string): string {
    return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  }

  /** Workspace paths are relative to the agent's cwd; project files have no such base, so they copy absolute. */
  async function copyPath() {
    const project = app.projects.find((candidate) => candidate.name === app.detail?.thread.project);
    const text = target.root === "project" && project ? `${project.path}/files/${target.path}` : target.path;
    await navigator.clipboard.writeText(text + formatLines(target.lines));
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  /** Relative links in rendered markdown open beside it in the panel; others in a new tab. */
  function onMarkdownClick(event: MouseEvent) {
    const link = (event.target as Element).closest("a");
    const href = link?.getAttribute("href");
    if (!link || !href) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) {
      link.target = "_blank";
      link.rel = "noreferrer";
      return;
    }
    event.preventDefault();
    if (href.startsWith("#")) return;
    const segments = parentPath(target.path).split("/").filter(Boolean);
    for (const segment of decodeURIComponent(href.split(/[?#]/)[0]!).split("/")) {
      if (segment === "..") segments.pop();
      else if (segment && segment !== ".") segments.push(segment);
    }
    open(segments.join("/"));
  }

  function formatSize(bytes: number): string {
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
  }
</script>

<svelte:window onkeydown={(event) => closeOnEscape(threadId, event)} />

<aside class="preview" style:width="{previewLayout.width}px">
  <!-- svelte-ignore a11y_no_static_element_interactions: a pointer-only convenience; the width is also kept between visits -->
  <div class="resize" onpointerdown={startResize}></div>
  <header>
    {#if content?.kind === "directory"}<Folder size={14} />{:else}<FileText size={14} />{/if}
    <span class="path truncate" title={label}>{label}<span class="lines">{formatLines(target.lines)}</span></span>
    {#if isMarkdown && content?.kind === "text"}
      <button class="ghost toggle" onclick={() => (raw = !raw)} title="Show {raw ? 'rendered' : 'source'}">
        {raw ? "Rendered" : "Source"}
      </button>
    {/if}
    <button class="ghost icon" title="Copy path" onclick={copyPath}>
      {#if copied}<Check size={14} />{:else}<Copy size={14} />{/if}
    </button>
    <a class="ghost icon button" href={fileUrl(threadId, target)} target="_blank" rel="noreferrer" title="Open in a new tab">
      <ExternalLink size={14} />
    </a>
    <button class="ghost icon" title="Reload" onclick={load} disabled={loading}><RefreshCw size={14} /></button>
    <button class="ghost icon" title="Close (Esc)" onclick={close}><X size={14} /></button>
  </header>
  <div class="body" bind:this={body}>
    {#if error}
      <p class="message error">{error}</p>
    {:else if !content}
      <p class="message muted">Loading…</p>
    {:else if content.kind === "image"}
      <div class="image"><img src={content.url} alt={label} /></div>
    {:else if content.kind === "directory"}
      <ul class="entries">
        {#if target.path.includes("/")}
          <li><button class="ghost entry" onclick={() => open(parentPath(target.path))}><Folder size={14} />..</button></li>
        {/if}
        {#each content.entries as entry (entry.name)}
          <li>
            <button class="ghost entry" onclick={() => open(`${target.path}/${entry.name}`)}>
              {#if entry.kind === "directory"}<Folder size={14} />{:else}<FileText size={14} />{/if}
              <span class="truncate">{entry.name}</span>
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      {#if content.fullSize !== null}
        <p class="message muted">Showing the first {formatSize(content.text.length)} of {formatSize(content.fullSize)}.</p>
      {/if}
      {#if isMarkdown && !raw}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions: the links inside are focusable -->
        <div class="markdown" onclick={onMarkdownClick}>
          {@html DOMPurify.sanitize(renderMarkdown(content.text, []))}
        </div>
      {:else}
        {@const range = target.lines}
        <div class="code">
          {#each lines as line, index (index)}
            {@const number = index + 1}
            <div class="line" class:marked={range && number >= range.start && number <= range.end} data-line={number}>
              <span class="number">{number}</span><span class="text">{line}</span>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
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
  .path {
    flex: 1;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
  .lines {
    color: var(--text-faint);
  }
  .toggle {
    font-size: var(--text-xs);
    padding: var(--space-0-5) var(--space-1-5);
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
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .message {
    padding: var(--space-3) var(--space-4) 0;
    font-size: var(--text-sm);
  }
  .image {
    padding: var(--space-3);
  }
  .image img {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 0 auto;
  }
  .entries {
    list-style: none;
    margin: 0;
    padding: var(--space-2);
  }
  .entry {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    font-size: var(--text-sm);
    text-align: left;
  }
  .markdown {
    padding: var(--space-3) var(--space-4);
    word-break: break-word;
  }
  .markdown :global(:is(p, ul, ol, pre, blockquote, table)) {
    margin: 0 0 var(--space-3);
  }
  .markdown :global(:is(h1, h2, h3, h4)) {
    margin: var(--space-4) 0 var(--space-2);
  }
  .markdown :global(> :first-child) {
    margin-top: 0;
  }
  .markdown :global(pre) {
    overflow-x: auto;
    background: var(--surface-raised);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
  }
  .markdown :global(img) {
    max-width: 100%;
  }
  .code {
    padding: var(--space-2) 0;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.6;
    width: max-content;
    min-width: 100%;
  }
  .line {
    display: flex;
    white-space: pre;
  }
  .line.marked {
    background: var(--accent-soft);
  }
  .number {
    position: sticky;
    left: 0;
    flex-shrink: 0;
    width: 4.5em;
    padding-right: var(--space-3);
    text-align: right;
    color: var(--text-faint);
    background: var(--surface-base);
    user-select: none;
  }
  .marked .number {
    color: var(--accent-hover);
  }
  .text {
    padding-right: var(--space-4);
  }
</style>
