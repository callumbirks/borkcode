<script lang="ts">
  import FileText from "@lucide/svelte/icons/file-text";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import { untrack } from "svelte";
  import { app, go, loadFiles, rpc } from "../lib/state.svelte";

  let { project, path }: { project: string; path: string } = $props();

  let content = $state("");
  /** What was loaded or last saved; edits are compared against it. */
  let saved = $state("");
  let modifiedAt = $state<number | null>(null);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state("");

  const dirty = $derived(content !== saved);
  const onDisk = $derived(app.files[project]?.find((file) => file.path === path));
  // Another writer, such as an agent, changed or removed the file since it was loaded.
  const changedElsewhere = $derived(
    !loading && app.files[project] !== undefined && onDisk?.modifiedAt !== modifiedAt,
  );

  async function load() {
    error = "";
    try {
      const file = await rpc.request("files.read", { project, path });
      content = file.content;
      saved = file.content;
      modifiedAt = file.modifiedAt;
    } catch (cause) {
      error = (cause as Error).message;
    } finally {
      loading = false;
    }
  }

  // Loads once per connection. Untracked, or every file broadcast would reload over the user's edits.
  $effect(() => {
    if (!app.connected) return;
    untrack(() => {
      void load();
      if (!app.files[project]) void loadFiles(project).catch(() => undefined);
    });
  });

  // Follow outside changes while there is nothing of ours to lose.
  $effect(() => {
    if (changedElsewhere && onDisk && !dirty) void load();
  });

  async function save() {
    if (saving) return;
    saving = true;
    error = "";
    try {
      const file = await rpc.request("files.write", { project, path, content, expectedModifiedAt: modifiedAt });
      saved = content;
      modifiedAt = file.modifiedAt;
    } catch (cause) {
      error = (cause as Error).message;
    } finally {
      saving = false;
    }
  }

  async function remove() {
    if (!confirm(`Delete ${path}? Every thread of ${project} shares it.`)) return;
    try {
      await rpc.request("files.delete", { project, path });
      go({ view: "project", name: project });
    } catch (cause) {
      error = (cause as Error).message;
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "s" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void save();
    }
  }
</script>

<div class="file">
  <header>
    <div class="crumbs">
      <FileText size={14} />
      <a href="#/project/{encodeURIComponent(project)}">{project}</a>
      <span class="faint">/ files /</span>
      <code>{path}</code>
    </div>
    <div class="buttons">
      {#if dirty}<span class="chip unsaved">Unsaved</span>{/if}
      <button class="ghost icon" title="Delete file" onclick={remove} disabled={loading || !onDisk}>
        <Trash2 size={16} />
      </button>
      <button class="primary" title="Save (Ctrl+S)" onclick={save} disabled={loading || saving || !dirty}>Save</button>
    </div>
  </header>
  {#if changedElsewhere && dirty}
    <div class="banner">
      {onDisk ? "This file changed since you opened it." : "This file was deleted since you opened it."}
      {#if onDisk}<button onclick={load}>Discard my edits and reload</button>{/if}
    </div>
  {/if}
  {#if error}<p class="error">{error}</p>{/if}
  {#if loading}
    <p class="muted loading">Loading…</p>
  {:else}
    <textarea bind:value={content} onkeydown={onKeydown} spellcheck="false"></textarea>
  {/if}
</div>

<style>
  .file {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
    height: var(--header-height);
    padding: 0 var(--space-3) 0 var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
  }
  .crumbs {
    display: flex;
    align-items: center;
    gap: var(--space-1-5);
    min-width: 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .faint {
    color: var(--text-faint);
  }
  .buttons {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }
  .unsaved {
    color: var(--status-warning);
    background: var(--status-warning-soft);
  }
  .error,
  .loading {
    padding: var(--space-3) var(--space-4) 0;
  }
  textarea {
    flex: 1;
    margin: 0;
    padding: var(--space-4) var(--space-6);
    resize: none;
    background: none;
    border: none;
    border-radius: 0;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
  }
</style>
