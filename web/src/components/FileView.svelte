<script lang="ts">
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
    <div>
      <a href="#/project/{encodeURIComponent(project)}">{project}</a>
      <span class="muted">/ files /</span>
      <code>{path}</code>
    </div>
    <div class="row">
      {#if dirty}<span class="muted">Unsaved changes</span>{/if}
      <button class="danger" onclick={remove} disabled={loading || !onDisk}>Delete</button>
      <button class="primary" onclick={save} disabled={loading || saving || !dirty}>Save</button>
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
    <p class="muted">Loading…</p>
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
    padding: 10px 20px;
    border-bottom: 1px solid var(--border);
  }
  .row {
    align-items: center;
  }
  .banner {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 20px;
    background: var(--warn-bg);
    color: var(--warn);
    font-size: 13px;
  }
  .error {
    padding: 0 20px;
  }
  textarea {
    flex: 1;
    margin: 12px 20px 20px;
    resize: none;
    font-family: "JetBrains Mono", ui-monospace, Menlo, monospace;
    font-size: 13px;
    line-height: 1.5;
  }
</style>
