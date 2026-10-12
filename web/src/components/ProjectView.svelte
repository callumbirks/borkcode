<script lang="ts">
  import Plus from "@lucide/svelte/icons/plus";
  import { providerLabel, relativeTime } from "../lib/display.svelte";
  import { app, go, loadFiles, rpc, startNewThread } from "../lib/state.svelte";
  import FileTree from "./FileTree.svelte";
  import RepoEditor from "./RepoEditor.svelte";

  let { name }: { name: string } = $props();

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

      <div class="start">
        <button
          class="primary"
          onclick={() => startNewThread(name)}
          disabled={project.repos.length === 0}
          title={project.repos.length === 0 ? "Add a repository first" : `Start a thread in ${name}`}
        >
          <Plus size={14} />New thread
        </button>
        {#if project.repos.length === 0}<span class="muted">Add a repository first.</span>{/if}
      </div>

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
  .start {
    display: flex;
    align-items: center;
    gap: var(--space-3);
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
