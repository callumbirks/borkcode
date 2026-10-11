<script lang="ts">
  import DOMPurify from "dompurify";
  import { marked } from "marked";
  import type { Item } from "shared/protocol";

  let { item }: { item: Item } = $props();

  function markdown(text: string): string {
    return DOMPurify.sanitize(marked.parse(text, { async: false }));
  }
</script>

{#if item.kind === "user"}
  <div class="user">{item.text}</div>
{:else if item.kind === "assistant"}
  {#if item.text}
    <div class="assistant">{@html markdown(item.text)}</div>
  {/if}
{:else if item.kind === "reasoning"}
  {#if item.text}
    <details class="reasoning">
      <summary>Thinking</summary>
      <div>{@html markdown(item.text)}</div>
    </details>
  {/if}
{:else if item.kind === "tool"}
  <details class="tool {item.status}">
    <summary>
      <span class="name">{item.name}</span>
      <code>{item.summary}</code>
    </summary>
    {#if item.output}<pre>{item.output}</pre>{/if}
  </details>
{:else if item.kind === "notice"}
  <div class="notice {item.level}">{item.text}</div>
{/if}

<style>
  .user {
    background: var(--panel-2);
    border-radius: 8px;
    padding: 8px 12px;
    margin: 16px 0 8px;
    white-space: pre-wrap;
  }
  .assistant {
    margin: 8px 0;
  }
  .assistant :global(pre) {
    background: var(--panel);
    padding: 8px 12px;
    border-radius: 6px;
    overflow-x: auto;
  }
  .reasoning,
  .tool {
    margin: 4px 0;
    font-size: 13px;
    color: var(--muted);
  }
  summary {
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name {
    color: var(--text);
    margin-right: 6px;
  }
  .tool.running .name {
    color: var(--accent);
  }
  .tool.failed .name {
    color: var(--danger);
  }
  pre {
    background: var(--panel);
    padding: 8px 12px;
    border-radius: 6px;
    max-height: 320px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .notice {
    margin: 8px 0;
    font-size: 13px;
    color: var(--muted);
    white-space: pre-wrap;
  }
  .notice.error {
    color: var(--danger);
  }
</style>
