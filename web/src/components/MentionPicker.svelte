<script lang="ts">
  import MessagesSquare from "@lucide/svelte/icons/messages-square";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import type { Mention, MentionScope, ProviderCommand, ProviderKind } from "shared/protocol";
  import { commandAt, insertCommand, searchCommands } from "../lib/commands";
  import { enterThreadMode, fileName, insertMention, mentionAt, mentionSearch, pickerEntries, type PickerEntry } from "../lib/mentions";
  import { app, commands, loadCommands, rpc } from "../lib/state.svelte";
  import type ComposerEditor from "./ComposerEditor.svelte";

  // Suggests what to insert after an `@` typed in the composer, or the provider's commands after a
  // `/` that opens the message. The composer forwards its keydown events to `keydown`, which
  // claims the ones the open list uses.
  let {
    scope,
    editor,
    text,
    provider,
    newThread = false,
  }: {
    scope: MentionScope;
    editor: ComposerEditor | undefined;
    text: string;
    provider: ProviderKind;
    /** Offers only the commands that can open a thread. */
    newThread?: boolean;
  } = $props();

  type Entry = PickerEntry | { kind: "command"; reference: string; command: ProviderCommand };

  let caret = $state(0);
  let focused = $state(false);
  let results = $state<Mention[]>([]);
  let active = $state(0);
  /** Where the reference closed with Escape starts, so it stays closed while it is edited. */
  let dismissed = $state<number | null>(null);
  let list = $state<HTMLElement>();

  const slash = $derived(focused ? commandAt(text, caret) : null);
  const typing = $derived(slash ?? (focused ? mentionAt(text, caret) : null));
  const query = $derived(slash || !typing ? null : typing.query);
  const offered = $derived((commands[provider] ?? []).filter((command) => !newThread || command.firstMessage));
  const entries: Entry[] = $derived(
    slash
      ? searchCommands(offered, slash.query).map((command) => ({ kind: "command", reference: `/${command.name}`, command }))
      : query === null
        ? []
        : pickerEntries(query, results),
  );
  /** The command menu was closed with Escape; it stays closed until the `/` is typed again. */
  let commandDismissed = $state(false);
  const open = $derived(
    (slash ? !commandDismissed : typing !== null && typing.start !== dismissed) && entries.length > 0,
  );

  $effect(() => {
    if (app.connected) void loadCommands(provider);
  });

  $effect(() => {
    if (!slash) commandDismissed = false;
  });

  // A new filter starts from the best match.
  $effect(() => {
    void slash?.query;
    active = 0;
  });

  $effect(() => {
    const box = editor;
    const element = box?.node();
    if (!box || !element) return;
    const sync = () => {
      focused = document.activeElement === element;
      caret = box.caret();
    };
    // Removing a focused textarea fires blur inside Svelte's route rendering. Defer the
    // state write until that render finishes, and account for focus moving back meanwhile.
    const blur = () => queueMicrotask(() => (focused = document.activeElement === element));
    document.addEventListener("selectionchange", sync);
    element.addEventListener("input", sync);
    element.addEventListener("select", sync);
    element.addEventListener("keyup", sync);
    element.addEventListener("focus", sync);
    element.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("selectionchange", sync);
      element.removeEventListener("input", sync);
      element.removeEventListener("select", sync);
      element.removeEventListener("keyup", sync);
      element.removeEventListener("focus", sync);
      element.removeEventListener("blur", blur);
    };
  });

  let request = 0;
  $effect(() => {
    const current = query;
    const from = scope;
    const ticket = ++request;
    if (current === null) {
      results = [];
      dismissed = null;
      return;
    }
    results = [];
    active = 0;
    const timer = setTimeout(async () => {
      const found = await rpc.request("mentions.search", { ...from, ...mentionSearch(current) }).catch(() => []);
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
    if (event.key === "ArrowDown") active = (active + 1) % entries.length;
    else if (event.key === "ArrowUp") active = (active - 1 + entries.length) % entries.length;
    else if (event.key === "Enter" || event.key === "Tab") choose(entries[active]);
    else if (event.key === "Escape") {
      if (slash) commandDismissed = true;
      else dismissed = typing.start;
    } else return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function choose(mention: Entry) {
    if (!typing || !editor) return;
    const next = mention.kind === "command"
      ? insertCommand(text, caret, mention.command.name)
      : mention.kind === "category"
        ? enterThreadMode(text, typing.start, caret)
        : insertMention(text, typing.start, caret, mention.reference);
    results = [];
    editor.setText(next.text, next.caret);
    // A tap moves the caret without a key event, and a touch textarea's selectionchange may not
    // reach the document.
    caret = next.caret;
  }

  /** How a suggestion is shown; each kind of mention adds its case here. */
  function describe(mention: Entry): { title: string; label: string; detail: string } {
    if (mention.kind === "command") {
      return { title: mention.reference, label: mention.command.argumentHint, detail: mention.command.description };
    }
    if (mention.kind === "category") return { title: "Threads", label: "", detail: "Search threads in all projects" };
    if (mention.kind === "thread") return { title: `↳ ${mention.title}`, label: "Thread", detail: `${mention.project} · ${mention.status}` };
    return { title: fileName(mention.path), label: mention.repo ?? "Project files", detail: mention.path };
  }
</script>

{#if open}
  <div class="mentions" role="listbox" aria-label={slash ? "Commands" : "Mentions"} bind:this={list}>
    {#each entries as mention, index (mention.reference)}
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
        <span class="title truncate">{#if mention.kind === "category"}<MessagesSquare size={14} />{/if}{row.title}</span>
        {#if row.label}<span class="label">{row.label}</span>{/if}
        <span class="detail truncate">{row.detail}</span>
        {#if mention.kind === "category"}<ChevronRight size={14} />{/if}
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
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
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
