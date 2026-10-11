<script lang="ts">
  import { tick } from "svelte";
  import type { Mention } from "shared/protocol";
  import { fileName, insertMention, mentionAt } from "../lib/mentions";
  import { rpc } from "../lib/state.svelte";

  // Suggests what to insert after an `@` typed in the composer. The composer forwards its keydown
  // events to `keydown`, which claims the ones the open list uses.
  let {
    threadId,
    textarea,
    text,
    onchange,
  }: {
    threadId: string;
    textarea: HTMLTextAreaElement | undefined;
    text: string;
    onchange: (text: string) => void;
  } = $props();

  let caret = $state(0);
  let focused = $state(false);
  let results = $state<Mention[]>([]);
  let active = $state(0);
  /** Where the reference closed with Escape starts, so it stays closed while it is edited. */
  let dismissed = $state<number | null>(null);
  let list = $state<HTMLElement>();

  const typing = $derived(focused ? mentionAt(text, caret) : null);
  const query = $derived(typing?.query ?? null);
  const open = $derived(typing !== null && typing.start !== dismissed && results.length > 0);

  $effect(() => {
    const element = textarea;
    if (!element) return;
    const sync = () => {
      focused = document.activeElement === element;
      caret = element.selectionStart === element.selectionEnd ? element.selectionStart : -1;
    };
    const blur = () => (focused = false);
    const events = ["input", "click", "keyup", "focus"] as const;
    for (const name of events) element.addEventListener(name, sync);
    element.addEventListener("blur", blur);
    return () => {
      for (const name of events) element.removeEventListener(name, sync);
      element.removeEventListener("blur", blur);
    };
  });

  let request = 0;
  $effect(() => {
    const current = query;
    const thread = threadId;
    const ticket = ++request;
    if (current === null) {
      results = [];
      dismissed = null;
      return;
    }
    const timer = setTimeout(async () => {
      const found = await rpc.request("mentions.search", { threadId: thread, query: current }).catch(() => []);
      if (ticket !== request) return;
      results = found;
      active = 0;
    }, 80);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    list?.children[active]?.scrollIntoView({ block: "nearest" });
  });

  /** Handles the keys the open list uses; returns whether it did. */
  export function keydown(event: KeyboardEvent): boolean {
    if (!open || !typing || event.isComposing) return false;
    if (event.key === "ArrowDown") active = (active + 1) % results.length;
    else if (event.key === "ArrowUp") active = (active - 1 + results.length) % results.length;
    else if (event.key === "Enter" || event.key === "Tab") void choose(results[active]);
    else if (event.key === "Escape") dismissed = typing.start;
    else return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  async function choose(mention: Mention) {
    if (!typing || !textarea) return;
    const next = insertMention(text, typing.start, caret, mention.reference);
    onchange(next.text);
    results = [];
    await tick();
    textarea.focus();
    textarea.setSelectionRange(next.caret, next.caret);
    caret = next.caret;
  }

  /** How a suggestion is shown; each kind of mention adds its case here. */
  function describe(mention: Mention): { title: string; label: string; detail: string } {
    return { title: fileName(mention.path), label: mention.repo ?? "Project files", detail: mention.path };
  }
</script>

{#if open}
  <div class="mentions" role="listbox" bind:this={list}>
    {#each results as mention, index (mention.reference)}
      {@const row = describe(mention)}
      <button
        class="mention ghost"
        class:active={index === active}
        role="option"
        aria-selected={index === active}
        tabindex="-1"
        onmousedown={(event) => event.preventDefault()}
        onmousemove={() => (active = index)}
        onclick={() => choose(mention)}
      >
        <span class="title truncate">{row.title}</span>
        <span class="label">{row.label}</span>
        <span class="detail truncate">{row.detail}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .mentions {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + var(--space-1));
    z-index: 10;
    display: flex;
    flex-direction: column;
    max-height: 280px;
    overflow-y: auto;
    padding: var(--space-1);
    background: var(--surface-overlay);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
  }
  .mention {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    text-align: left;
    flex-shrink: 0;
  }
  .mention.active {
    background: var(--surface-active);
  }
  .title {
    flex-shrink: 0;
    max-width: 50%;
    color: var(--text-primary);
  }
  .label {
    flex-shrink: 0;
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
  .detail {
    flex: 1;
    min-width: 0;
    font-size: var(--text-xs);
    color: var(--text-faint);
  }
</style>
