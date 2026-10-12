<script lang="ts">
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import Plus from "@lucide/svelte/icons/plus";
  import type { AccessMode, Effort, ProviderKind } from "shared/protocol";
  import { providerLabel, relativeTime } from "../lib/display.svelte";
  import { untrack } from "svelte";
  import { app, go, loadFiles, models, rpc } from "../lib/state.svelte";
  import { parseThreadDefaults, rememberThread, settingsFor, threadDefaultsKey, validChoice } from "../lib/threadDefaults";
  import FileTree from "./FileTree.svelte";
  import ComposerOptions from "./ComposerOptions.svelte";
  import { resizeTextarea } from "../lib/textarea";
  import RepoEditor from "./RepoEditor.svelte";

  let { name, compact = false }: { name: string; compact?: boolean } = $props();

  const project = $derived(app.projects.find((candidate) => candidate.name === name));
  const threads = $derived(
    app.threads.filter((thread) => thread.project === name && thread.archivedAt === null).sort((a, b) => b.updatedAt - a.updatedAt),
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
  // Starts from this device's last new thread; role and workspace always start as Thread and Worktree.
  let saved = parseThreadDefaults(localStorage.getItem(threadDefaultsKey));
  const initial = settingsFor(saved, saved.provider);
  let provider = $state<ProviderKind>(saved.provider);
  let model = $state<string | null>(initial.model);
  let effort = $state<Effort | null>(initial.effort);
  let accessMode = $state<AccessMode>(initial.accessMode);
  let isolated = $state(true);
  let captain = $state(false);
  let starting = $state(false);
  let threadError = $state("");

  function pickProvider(next: ProviderKind) {
    ({ model, effort, accessMode } = settingsFor(saved, next));
  }

  // A saved model or effort the provider no longer offers quietly becomes its default once the
  // list arrives. Picks made after that come from the list, so this only runs per provider.
  $effect(() => {
    const catalog = models[provider];
    if (!catalog || catalog.error) return;
    untrack(() => ({ model, effort } = validChoice({ model, effort }, catalog.list)));
  });

  let textarea = $state<HTMLTextAreaElement>();
  $effect(() => {
    void message;
    if (textarea) {
      if (compact) resizeTextarea(textarea);
      else textarea.style.height = "";
    }
  });

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
        // Captains always get their own worktree.
        isolated: isolated || captain,
        captain,
      });
      saved = rememberThread(saved, provider, { model, effort, accessMode });
      localStorage.setItem(threadDefaultsKey, JSON.stringify(saved));
      go({ view: "thread", id: thread.id });
    } catch (cause) {
      threadError = (cause as Error).message;
    } finally {
      starting = false;
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (!compact && event.key === "Enter" && !event.shiftKey && !event.isComposing) {
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
          bind:this={textarea}
          onkeydown={onKeydown}
          rows={compact ? 1 : 3}
          aria-label="New thread message"
          placeholder={compact ? "What should the agent do?" : "What should the agent do? The thread is named from this."}
          required
        ></textarea>
        <div class="actions">
          <ComposerOptions bind:provider bind:model bind:effort bind:accessMode bind:captain bind:isolated newThread onpickprovider={pickProvider} />
          <span class="grow"></span>
          <button
            class="primary icon"
            type="submit"
            aria-label="Start thread"
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
        <FileTree project={name} {files} />
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
  @media (max-width: 900px) {
    textarea { min-height: 44px; max-height: 24vh; font-size: 16px; }
    .actions .grow { display: none; }
    .actions { flex-wrap: nowrap; }
  }
</style>
