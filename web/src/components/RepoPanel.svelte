<script lang="ts">
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
  import Copy from "@lucide/svelte/icons/copy";
  import FolderGit2 from "@lucide/svelte/icons/folder-git-2";
  import GitMerge from "@lucide/svelte/icons/git-merge";
  import GitPullRequest from "@lucide/svelte/icons/git-pull-request";
  import GitPullRequestClosed from "@lucide/svelte/icons/git-pull-request-closed";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
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

  const prIcons = { open: GitPullRequest, merged: GitMerge, closed: GitPullRequestClosed };
  const newestFirst = $derived([...pullRequests].reverse());

  // Refresh when the thread settles: after setup, and after each turn.
  $effect(() => {
    if (status === "idle" || status === "error") void refresh();
  });
</script>

<aside>
  <header>
    <span class="section-label">Overview</span>
    <button class="ghost icon" title="Refresh" onclick={refresh} disabled={loading}>
      <RefreshCw size={14} />
    </button>
  </header>

  <section>
    <div class="section-label">Pull requests <span class="count">{pullRequests.length}</span></div>
    {#each newestFirst as pr (pr.url)}
      {@const state = pr.state.toLowerCase() as keyof typeof prIcons}
      {@const Icon = prIcons[state] ?? GitPullRequest}
      <a class="pr" href={pr.url} target="_blank" rel="noreferrer" title="{pr.state.toLowerCase()} · open on GitHub">
        <span class="pr-{state}"><Icon size={14} /></span>
        <span class="pr-lines">
          <span class="pr-title truncate">{pr.title}</span>
          <span class="pr-ref">{pr.repo}#{pr.number} · <span class="pr-{state}">{state}</span></span>
        </span>
        <ArrowUpRight size={14} class="external" />
      </a>
    {:else}
      <p class="empty">No pull requests yet.</p>
    {/each}
  </section>

  <section>
    <div class="section-label">Repositories <span class="count">{repos.length}</span></div>
    {#each repos as repo (repo.name)}
      <div class="repo">
        <div class="repo-name">
          <FolderGit2 size={14} />
          <span class="truncate">{repo.name}</span>
        </div>
        {#if !repo.exists}
          <span class="repo-meta">Not checked out yet</span>
        {:else}
          <span class="repo-meta truncate" title={repo.branch ?? undefined}>{repo.branch} ← {repo.baseBranch}</span>
          <div class="facts">
            <span class="chip" class:ahead={(repo.ahead ?? 0) > 0}>{repo.ahead ?? "?"} ahead</span>
            {#if repo.changedFiles.length > 0}
              <span class="chip uncommitted">{repo.changedFiles.length} uncommitted</span>
            {/if}
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
  </section>

  <footer>
    <button class="ghost path" title="Copy workspace path" onclick={() => navigator.clipboard.writeText(workspacePath)}>
      <Copy size={12} />
      <span class="truncate">{workspacePath}</span>
    </button>
  </footer>
</aside>

<style>
  aside {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    border-left: 1px solid var(--border-subtle);
    padding: 0 var(--space-3) var(--space-3);
    overflow-y: auto;
    font-size: var(--text-sm);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    height: var(--header-height);
    margin: 0 calc(-1 * var(--space-3));
    padding: 0 var(--space-2) 0 var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  section > .section-label {
    padding: 0 var(--space-1);
    margin-bottom: var(--space-1);
  }
  .empty {
    padding: 0 var(--space-1);
    color: var(--text-faint);
    font-size: var(--text-xs);
  }
  .pr {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-1-5);
    border-radius: var(--radius-md);
    color: var(--text-primary);
  }
  .pr:hover {
    background: var(--surface-hover);
    text-decoration: none;
  }
  .pr > span:first-child {
    display: flex;
    margin-top: 3px;
  }
  .pr-lines {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .pr-ref {
    font-size: var(--text-xs);
    color: var(--text-faint);
  }
  .pr :global(.external) {
    flex-shrink: 0;
    margin-top: 3px;
    color: var(--text-faint);
    opacity: 0;
  }
  .pr:hover :global(.external) {
    opacity: 1;
  }
  .repo {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-1-5);
    border-top: 1px solid var(--border-subtle);
  }
  .repo:first-of-type {
    border-top: none;
  }
  .repo-name {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-weight: var(--weight-medium);
  }
  .repo-meta {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
  }
  .facts {
    display: flex;
    gap: var(--space-1);
  }
  .chip.ahead {
    color: var(--diff-added);
    background: var(--status-success-soft);
  }
  .chip.uncommitted {
    color: var(--status-warning);
    background: var(--status-warning-soft);
  }
  details summary {
    font-size: var(--text-xs);
    color: var(--text-muted);
    cursor: pointer;
  }
  pre {
    margin: var(--space-1) 0 0;
    white-space: pre-wrap;
    word-break: break-all;
    color: var(--text-secondary);
  }
  footer {
    margin-top: auto;
  }
  .path {
    width: 100%;
    justify-content: flex-start;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    font-weight: var(--weight-regular);
    color: var(--text-faint);
  }
  .path :global(svg) {
    flex-shrink: 0;
  }
</style>
