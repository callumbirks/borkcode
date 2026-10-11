<script lang="ts">
  import type { LinkedPullRequest, RepoStatus, ThreadStatus } from "shared/protocol";
  import { rpc } from "../lib/state.svelte";

  let {
    threadId,
    status,
    workspacePath,
    pullRequests,
  }: { threadId: string; status: ThreadStatus; workspacePath: string; pullRequests: LinkedPullRequest[] } = $props();

  let repos = $state<RepoStatus[]>([]);
  let loading = $state(false);

  async function refresh() {
    loading = true;
    try {
      repos = await rpc.request("threads.repoStatus", { threadId });
    } catch {
      // Keep the last known status; the panel is informational.
    } finally {
      loading = false;
    }
  }

  // Refresh when the thread settles: after setup, and after each turn.
  $effect(() => {
    if (status === "idle" || status === "error") void refresh();
  });
</script>

<aside>
  <div class="heading">
    <strong>Workspace</strong>
    <button onclick={refresh} disabled={loading}>{loading ? "…" : "Refresh"}</button>
  </div>
  <code class="path" title="Copy path">
    <button class="link" onclick={() => navigator.clipboard.writeText(workspacePath)}>{workspacePath}</button>
  </code>
  {#each repos as repo (repo.name)}
    <div class="repo">
      <div class="name">
        <strong>{repo.name}/</strong>
        <span class="prs">
          {#each pullRequests.filter((pr) => pr.repo === repo.name).reverse() as pr (pr.url)}
            <a href={pr.url} target="_blank" rel="noreferrer" class="pr {pr.state.toLowerCase()}" title={pr.title}>
              #{pr.number} {pr.state.toLowerCase()}
            </a>
          {/each}
        </span>
      </div>
      {#if !repo.exists}
        <span class="muted">Not checked out yet</span>
      {:else}
        <div class="muted">{repo.branch}</div>
        <div class="muted">
          {repo.ahead ?? "?"} ahead of {repo.baseBranch} · {repo.changedFiles.length} uncommitted
        </div>
        {#if repo.changedFiles.length > 0}
          <details>
            <summary>Changed files</summary>
            <pre>{repo.changedFiles.join("\n")}</pre>
          </details>
        {/if}
      {/if}
    </div>
  {/each}
</aside>

<style>
  aside {
    border-left: 1px solid var(--border);
    background: var(--panel);
    padding: 12px 16px;
    overflow-y: auto;
    font-size: 13px;
  }
  .heading {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .path {
    display: block;
    margin: 8px 0 12px;
    word-break: break-all;
  }
  .link {
    all: unset;
    cursor: pointer;
    color: var(--muted);
  }
  .repo {
    padding: 10px 0;
    border-top: 1px solid var(--border);
  }
  .name {
    display: flex;
    justify-content: space-between;
  }
  .prs {
    display: flex;
    gap: 6px;
  }
  .pr {
    font-size: 12px;
  }
  .pr.merged {
    color: #b89cff;
  }
  .pr.closed {
    color: var(--danger);
  }
  .pr.open {
    color: var(--ok);
  }
  pre {
    margin: 4px 0;
    white-space: pre-wrap;
  }
</style>
