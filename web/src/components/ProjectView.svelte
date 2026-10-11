<script lang="ts">
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import FileText from "@lucide/svelte/icons/file-text";
  import Plus from "@lucide/svelte/icons/plus";
  import type { AccessMode, Effort, ProviderKind } from "shared/protocol";
  import { providerLabel, relativeTime } from "../lib/display.svelte";
  import { app, go, loadFiles, rpc } from "../lib/state.svelte";
  import ModelPicker from "./ModelPicker.svelte";
  import RepoEditor from "./RepoEditor.svelte";

  let { name }: { name: string } = $props();

  const project = $derived(app.projects.find((candidate) => candidate.name === name));
  const threads = $derived(
    app.threads.filter((thread) => thread.project === name).sort((a, b) => b.updatedAt - a.updatedAt),
  );

  const files = $derived(app.files[name] ?? []);
  let newPath = $state("");
  let fileError = $state("");

  $effect(() => {
    if (app.connected) loadFiles(name).catch((cause: Error) => (fileError = cause.message));
  });

  async function createFile(event: SubmitEvent) {
    event.preventDefault();
    fileError = "";
    try {
      const file = await rpc.request("files.write", { project: name, path: newPath, content: "", expectedModifiedAt: null });
      newPath = "";
      go({ view: "file", project: name, path: file.path });
    } catch (cause) {
      fileError = (cause as Error).message;
    }
  }

  function formatSize(bytes: number): string {
    return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
  }

  let repoUrl = $state("");
  let repoName = $state("");
  let cloning = $state(false);
  let repoError = $state("");

  async function addRepo(event: SubmitEvent) {
    event.preventDefault();
    cloning = true;
    repoError = "";
    try {
      await rpc.request("repos.add", { project: name, url: repoUrl, name: repoName || undefined });
      repoUrl = "";
      repoName = "";
    } catch (cause) {
      repoError = (cause as Error).message;
    } finally {
      cloning = false;
    }
  }

  let message = $state("");
  let provider = $state<ProviderKind>("claude");
  let model = $state<string | null>(null);
  let effort = $state<Effort | null>(null);
  let accessMode = $state<AccessMode>("ask");
  let isolated = $state(true);
  let starting = $state(false);
  let threadError = $state("");

  function pickProvider(next: ProviderKind) {
    provider = next;
    model = null;
    effort = null;
  }

  async function createThread(event?: SubmitEvent) {
    event?.preventDefault();
    if (!message.trim() || starting || project?.repos.length === 0) return;
    threadError = "";
    starting = true;
    try {
      const thread = await rpc.request("threads.create", {
        project: name,
        text: message,
        provider,
        model,
        effort,
        accessMode,
        isolated,
      });
      go({ view: "thread", id: thread.id });
    } catch (cause) {
      threadError = (cause as Error).message;
    } finally {
      starting = false;
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void createThread();
    }
  }
</script>

<div class="page">
  {#if !project}
    <p class="muted">Loading project…</p>
  {:else}
    <div class="page-inner">
      <div class="page-header">
        <h1>{project.name}</h1>
        <code class="muted">{project.path}</code>
      </div>

      <form class="composer" onsubmit={createThread}>
        <textarea
          bind:value={message}
          onkeydown={onKeydown}
          rows="3"
          placeholder="What should the agent do? The thread is named from this."
          required
        ></textarea>
        <div class="actions">
          <select
            title="Agent"
            value={provider}
            onchange={(event) => pickProvider(event.currentTarget.value as ProviderKind)}
          >
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
          <ModelPicker {provider} bind:model bind:effort compact />
          <select title="Access" bind:value={accessMode}>
            <option value="ask">Ask first</option>
            <option value="full">Full access</option>
          </select>
          <select title="Workspace" bind:value={isolated}>
            <option value={true}>New worktrees</option>
            <option value={false}>Main checkouts</option>
          </select>
          <span class="grow"></span>
          <button
            class="primary icon"
            type="submit"
            title="Start thread (Enter)"
            disabled={project.repos.length === 0 || starting || !message.trim()}
          >
            <ArrowUp size={16} />
          </button>
        </div>
      </form>
      {#if project.repos.length === 0}<p class="muted">Add a repository first.</p>{/if}
      {#if threadError}<p class="error">{threadError}</p>{/if}

      {#if threads.length > 0}
        <section class="card">
          <div class="section-label">Threads <span class="count">{threads.length}</span></div>
          <div class="list">
            {#each threads as thread (thread.id)}
              <button class="list-row" onclick={() => go({ view: "thread", id: thread.id })}>
                <span class="dot {thread.status}" title={thread.status}></span>
                <span class="truncate grow">{thread.title}</span>
                <span class="chip provider-{thread.provider}">{providerLabel[thread.provider]}</span>
                {#if !thread.workspace}<span class="chip">main checkout</span>{/if}
                <span class="time">{relativeTime(thread.updatedAt)}</span>
              </button>
            {/each}
          </div>
        </section>
      {/if}

      <section class="card">
        <div class="section-label">Shared files <span class="count">{files.length}</span></div>
        <p class="muted hint">Notes, specs and plans that you and every thread of this project can read and write.</p>
        <div class="list">
          {#each files as file (file.path)}
            <button class="list-row" onclick={() => go({ view: "file", project: name, path: file.path })}>
              <FileText size={16} class="muted" />
              <code class="truncate grow">{file.path}</code>
              <span class="time">{formatSize(file.size)}</span>
              <span class="time">{relativeTime(file.modifiedAt)}</span>
            </button>
          {/each}
        </div>
        <form class="inline" onsubmit={createFile}>
          <input bind:value={newPath} placeholder="New file, e.g. specs/login.md" required />
          <button type="submit"><Plus size={14} />Create</button>
        </form>
        {#if fileError}<p class="error">{fileError}</p>{/if}
      </section>

      <section class="card">
        <div class="section-label">Repositories <span class="count">{project.repos.length}</span></div>
        <div>
          {#each project.repos as repo (repo.name)}
            <RepoEditor project={project.name} {repo} />
          {/each}
        </div>
        <form class="inline" onsubmit={addRepo}>
          <input class="grow" bind:value={repoUrl} placeholder="Git URL or GitHub owner/repo" required />
          <input bind:value={repoName} placeholder="Directory (from URL)" size="18" />
          <button type="submit" disabled={cloning}><Plus size={14} />{cloning ? "Cloning…" : "Add"}</button>
        </form>
        {#if repoError}<p class="error">{repoError}</p>{/if}
      </section>
    </div>
  {/if}
</div>

<style>
  .composer {
    background: var(--surface-raised);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-xl);
    padding: var(--space-3) var(--space-3) var(--space-2);
    transition: border-color var(--transition-fast);
  }
  .composer:focus-within {
    border-color: var(--border-strong);
  }
  textarea {
    display: block;
    width: 100%;
    resize: none;
    background: none;
    border: none;
    padding: 0;
    font-size: var(--text-md);
    field-sizing: content;
    min-height: 66px;
    max-height: 240px;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    margin-top: var(--space-2);
  }
  .actions select {
    background: none;
    border-color: transparent;
    color: var(--text-secondary);
    padding: var(--space-1) var(--space-1-5);
  }
  .actions select:hover {
    background: var(--surface-hover);
    color: var(--text-primary);
  }
  .actions .icon {
    border-radius: var(--radius-full);
  }
  .hint {
    font-size: var(--text-xs);
  }
  .time {
    flex-shrink: 0;
    font-size: var(--text-xs);
    color: var(--text-faint);
  }
  .inline {
    display: flex;
    gap: var(--space-2);
  }
  .inline input:first-child {
    flex: 1;
  }
</style>
