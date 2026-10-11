<script lang="ts">
  import type { AccessMode, Effort, ProviderKind } from "shared/protocol";
  import { app, go, loadFiles, rpc } from "../lib/state.svelte";
  import ModelPicker from "./ModelPicker.svelte";
  import RepoEditor from "./RepoEditor.svelte";

  let { name }: { name: string } = $props();

  const project = $derived(app.projects.find((candidate) => candidate.name === name));
  const threads = $derived(
    app.threads.filter((thread) => thread.project === name).sort((a, b) => b.createdAt - a.createdAt),
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
    <h1>{project.name}</h1>
    <p class="muted"><code>{project.path}</code></p>

    <section class="card">
      <h2>New thread</h2>
      <form onsubmit={createThread}>
        <textarea
          bind:value={message}
          onkeydown={onKeydown}
          rows="3"
          placeholder="What should the agent do? The thread is named from this. (Enter to start, Shift+Enter for a new line)"
          required
        ></textarea>
        <div class="row">
          <label>
            Agent
            <select value={provider} onchange={(event) => pickProvider(event.currentTarget.value as ProviderKind)}>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <ModelPicker {provider} bind:model bind:effort />
          <label>
            Access
            <select bind:value={accessMode}>
              <option value="ask">Ask before acting</option>
              <option value="full">Full access</option>
            </select>
          </label>
          <label>
            Workspace
            <select bind:value={isolated}>
              <option value={true}>New worktrees</option>
              <option value={false}>Main checkouts</option>
            </select>
          </label>
          <button class="primary" type="submit" disabled={project.repos.length === 0 || starting || !message.trim()}>
            Start
          </button>
        </div>
      </form>
      {#if project.repos.length === 0}
        <p class="muted">Add a repository first.</p>
      {/if}
      {#if threadError}<p class="error">{threadError}</p>{/if}
    </section>

    <section class="card">
      <h2>Shared files</h2>
      <p class="muted">Notes, specs and plans that you and every thread of this project can read and write.</p>
      {#each files as file (file.path)}
        <button class="file" onclick={() => go({ view: "file", project: name, path: file.path })}>
          <code>{file.path}</code>
          <span class="muted">
            {formatSize(file.size)} · {new Date(file.modifiedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
          </span>
        </button>
      {:else}
        <p class="muted">No files yet.</p>
      {/each}
      <form class="row add" onsubmit={createFile}>
        <label class="grow">
          New file
          <input bind:value={newPath} placeholder="specs/login.md" required />
        </label>
        <button type="submit">Create</button>
      </form>
      {#if fileError}<p class="error">{fileError}</p>{/if}
    </section>

    <section class="card">
      <h2>Repositories</h2>
      {#each project.repos as repo (repo.name)}
        <RepoEditor project={project.name} {repo} />
      {/each}
      <form class="row add" onsubmit={addRepo}>
        <label class="grow">
          Git URL or GitHub owner/repo
          <input bind:value={repoUrl} placeholder="git@github.com:me/vessel.git" required />
        </label>
        <label>
          Directory name
          <input bind:value={repoName} placeholder="from URL" size="14" />
        </label>
        <button type="submit" disabled={cloning}>{cloning ? "Cloning…" : "Add repository"}</button>
      </form>
      {#if repoError}<p class="error">{repoError}</p>{/if}
    </section>

    {#if threads.length > 0}
      <section class="card">
        <h2>Threads</h2>
        {#each threads as thread (thread.id)}
          <button class="thread" onclick={() => go({ view: "thread", id: thread.id })}>
            <span>{thread.title}</span>
            <span class="muted">{thread.provider} · {thread.branch ?? "main checkouts"} · {thread.status}</span>
          </button>
        {/each}
      </section>
    {/if}
  {/if}
</div>

<style>
  .grow {
    flex: 1;
    min-width: 200px;
  }
  textarea {
    width: 100%;
    resize: vertical;
    margin-bottom: 8px;
  }
  .add {
    margin-top: 12px;
  }
  .file {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    background: none;
    border: none;
    padding: 6px 0;
    text-align: left;
  }
  .thread {
    display: flex;
    justify-content: space-between;
    width: 100%;
    background: none;
    border: none;
    padding: 6px 0;
  }
</style>
