<script lang="ts">
  import Brain from "@lucide/svelte/icons/brain";
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import CornerDownRight from "@lucide/svelte/icons/corner-down-right";
  import GitFork from "@lucide/svelte/icons/git-fork";
  import Info from "@lucide/svelte/icons/info";
  import DOMPurify from "dompurify";
  import { marked } from "marked";
  import type { Item } from "shared/protocol";
  import { providerLabel, toolIcon, toolLabel } from "../lib/display.svelte";
  import { app, go } from "../lib/state.svelte";

  let { item }: { item: Item } = $props();

  /** The other thread a handoff item points at; titles and status stay live as it works. */
  const linked = $derived.by(() => {
    const id = item.kind === "thread" ? item.threadId : item.kind === "user" ? item.fromThreadId : undefined;
    return id ? app.threads.find((thread) => thread.id === id) : undefined;
  });

  function markdown(text: string): string {
    return DOMPurify.sanitize(marked.parse(text, { async: false }));
  }
</script>

{#if item.kind === "user"}
  <div class="user">
    {#if item.fromThreadId}
      <div class="from">
        <CornerDownRight size={12} />
        {#if linked}
          From <a href="#/thread/{linked.id}">{linked.title}</a>
        {:else}
          From a thread that was since deleted
        {/if}
      </div>
    {/if}
    {#if item.fromBorkcode}<div class="from"><CornerDownRight size={12} />From borkcode</div>{/if}
    {#if item.steered}<div class="from">Read while working</div>{/if}
    {item.text}
  </div>
{:else if item.kind === "thread"}
  {#if linked}
    <button class="handoff" onclick={() => go({ view: "thread", id: linked.id })}>
      <GitFork size={14} />
      <span class="handoff-label">Started thread</span>
      <span class="truncate">{linked.title}</span>
      <span class="handoff-meta">{providerLabel[linked.provider]}</span>
      <span class="dot {linked.status}" title={linked.status}></span>
    </button>
  {:else}
    <div class="notice"><GitFork size={14} /><span>Started a thread that was since deleted</span></div>
  {/if}
{:else if item.kind === "assistant"}
  {#if item.text}
    <div class="assistant">{@html markdown(item.text)}</div>
  {/if}
{:else if item.kind === "reasoning"}
  {#if item.text}
    <details class="step">
      <summary>
        <Brain size={14} />
        <span class="name">Thinking</span>
      </summary>
      <div class="body reasoning">{@html markdown(item.text)}</div>
    </details>
  {/if}
{:else if item.kind === "tool"}
  {@const Icon = toolIcon(item.name)}
  <details class="step {item.status}">
    <summary class:static={!item.output}>
      <Icon size={14} />
      <span class="name">{toolLabel(item.name)}</span>
      <code class="summary truncate">{item.summary}</code>
      {#if item.status === "failed"}<span class="failed-label">failed</span>{/if}
    </summary>
    {#if item.output}<pre class="body">{item.output}</pre>{/if}
  </details>
{:else if item.kind === "notice"}
  <div class="notice {item.level}">
    {#if item.level === "error"}<CircleAlert size={14} />{:else}<Info size={14} />{/if}
    <span>{item.text}</span>
  </div>
{/if}

<style>
  .user {
    align-self: flex-end;
    max-width: 80%;
    background: var(--surface-overlay);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-xl);
    padding: var(--space-2-5) var(--space-3);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .assistant {
    color: var(--text-primary);
    word-break: break-word;
  }
  .assistant :global(> :first-child) {
    margin-top: 0;
  }
  .assistant :global(> :last-child) {
    margin-bottom: 0;
  }
  .assistant :global(p),
  .assistant :global(ul),
  .assistant :global(ol) {
    margin: 0 0 var(--space-3);
  }
  .assistant :global(code) {
    background: var(--surface-overlay);
    border-radius: var(--radius-sm);
    padding: 1px var(--space-1);
  }
  .assistant :global(pre) {
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    padding: var(--space-2-5) var(--space-3);
    border-radius: var(--radius-lg);
    overflow-x: auto;
  }
  .assistant :global(pre code) {
    background: none;
    padding: 0;
  }
  .step {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  summary {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-0-5) var(--space-1-5);
    border-radius: var(--radius-sm);
    cursor: pointer;
    list-style: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:hover {
    background: var(--surface-hover);
  }
  summary.static {
    cursor: default;
  }
  summary.static:hover {
    background: none;
  }
  summary :global(svg) {
    flex-shrink: 0;
  }
  .name {
    flex-shrink: 0;
    color: var(--text-secondary);
  }
  .summary {
    color: var(--text-faint);
  }
  .running .name {
    color: var(--status-running);
  }
  .failed .name,
  .failed-label {
    color: var(--status-danger);
  }
  .failed-label {
    flex-shrink: 0;
    font-size: var(--text-2xs);
  }
  .body {
    margin: var(--space-1) 0 var(--space-2) var(--space-6);
    padding: var(--space-2) var(--space-3);
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
  }
  pre.body {
    max-height: 320px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-secondary);
  }
  .reasoning :global(p) {
    margin: 0 0 var(--space-2);
  }
  .from {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    margin-bottom: var(--space-1-5);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .handoff {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    align-self: flex-start;
    max-width: 100%;
    font-size: var(--text-sm);
    color: var(--text-primary);
  }
  .handoff-label,
  .handoff-meta {
    flex-shrink: 0;
    color: var(--text-muted);
  }
  .notice {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-muted);
    white-space: pre-wrap;
  }
  .notice :global(svg) {
    flex-shrink: 0;
    margin-top: 3px;
  }
  .notice.error {
    color: var(--status-danger);
    background: var(--status-danger-soft);
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3);
  }
</style>
