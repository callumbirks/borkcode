<script lang="ts">
  import ArchiveRestore from "@lucide/svelte/icons/archive-restore";
  import type { Thread } from "shared/protocol";
  import { relativeTime } from "../lib/display.svelte";
  import { app, go, rpc } from "../lib/state.svelte";

  let error = $state("");

  // Grouped by project, most recently archived first.
  const byProject = $derived.by(() => {
    const groups = new Map<string, Thread[]>();
    const archived = app.threads.filter((thread) => thread.archivedAt !== null);
    for (const thread of archived.sort((a, b) => b.archivedAt! - a.archivedAt!)) {
      groups.set(thread.project, [...(groups.get(thread.project) ?? []), thread]);
    }
    return groups;
  });

  async function unarchive(threadId: string) {
    error = "";
    await rpc.request("threads.archive", { threadId, archived: false }).catch((cause: Error) => (error = cause.message));
  }
</script>

<div class="page">
  <div class="page-inner">
    <div class="page-header">
      <h1>Archived</h1>
      <p class="muted">
        Archived threads keep their transcript, workspace, branch and pull requests. Messaging one brings it back.
      </p>
    </div>
    {#if error}<p class="error">{error}</p>{/if}

    {#each byProject as [project, threads] (project)}
      <section class="card">
        <div class="section-label">{project} <span class="count">{threads.length}</span></div>
        <div class="list">
          {#each threads as thread (thread.id)}
            <div class="entry">
              <button class="list-row" onclick={() => go({ view: "thread", id: thread.id })}>
                <span class="dot {thread.status}" title={thread.status}></span>
                <span class="truncate grow">{thread.title}</span>
                <span class="time" title="Archived">{relativeTime(thread.archivedAt!)}</span>
              </button>
              <button class="ghost icon" title="Unarchive" onclick={() => unarchive(thread.id)}>
                <ArchiveRestore size={14} />
              </button>
            </div>
          {/each}
        </div>
      </section>
    {:else}
      <p class="muted">No archived threads.</p>
    {/each}
  </div>
</div>

<style>
  .entry {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }
  .time {
    flex-shrink: 0;
    font-size: var(--text-xs);
    color: var(--text-faint);
  }
</style>
