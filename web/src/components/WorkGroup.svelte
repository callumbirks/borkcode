<script lang="ts">
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import type { Item } from "shared/protocol";
  import { toolLabel } from "../lib/display.svelte";
  import type { ReferenceRoots } from "../lib/fileReferences";
  import ItemView from "./ItemView.svelte";

  /** A run of tool calls and reasoning between messages, folded into one line so the answer stays readable. */
  let { items, threadId, roots }: { items: Item[]; threadId: string; roots: ReferenceRoots | null } = $props();

  const tools = $derived(items.filter((item) => item.kind === "tool"));
  const failed = $derived(tools.filter((tool) => tool.status === "failed").length);
  const running = $derived(tools.some((tool) => tool.status === "running"));
  const last = $derived(tools.at(-1));
  let opened = $state(false);
  const label = $derived(
    tools.length === 0 ? "Thought" : `${tools.length} ${tools.length === 1 ? "step" : "steps"}`,
  );
</script>

<!-- Steps render once the group is first opened: long threads hold hundreds of them, mostly unread. -->
<details class="group" class:running ontoggle={(event) => (opened ||= event.currentTarget.open)}>
  <summary>
    <span class="chevron"><ChevronRight size={14} /></span>
    <span class="label">{label}</span>
    {#if failed > 0}<span class="failed">{failed} failed</span>{/if}
    <!-- The latest step, so progress is visible without expanding. -->
    {#if last}
      <span class="latest truncate">
        {toolLabel(last.name)}
        <code>{last.summary}</code>
      </span>
    {/if}
  </summary>
  {#if opened}
    <div class="steps">
      {#each items as item (item.id)}
        <ItemView {item} {threadId} {roots} />
      {/each}
    </div>
  {/if}
</details>

<style>
  .group {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  summary {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-1-5);
    margin: 0 calc(-1 * var(--space-1-5));
    border-radius: var(--radius-md);
    cursor: pointer;
    list-style: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:hover {
    background: var(--surface-hover);
  }
  .chevron {
    display: flex;
    color: var(--text-faint);
    transition: transform var(--transition-fast);
  }
  .group[open] .chevron {
    transform: rotate(90deg);
  }
  .label {
    flex-shrink: 0;
    color: var(--text-secondary);
  }
  .running .label {
    color: var(--status-running);
  }
  .failed {
    flex-shrink: 0;
    color: var(--status-danger);
    font-size: var(--text-xs);
  }
  .latest {
    color: var(--text-faint);
  }
  .latest code {
    margin-left: var(--space-1);
  }
  .group[open] .latest {
    display: none;
  }
  .steps {
    display: flex;
    flex-direction: column;
    gap: var(--space-0-5);
    margin: var(--space-1) 0 0 var(--space-1);
    padding-left: var(--space-3);
    border-left: 1px solid var(--border-subtle);
  }
</style>
