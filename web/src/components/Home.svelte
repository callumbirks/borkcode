<script lang="ts">
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Folder from "@lucide/svelte/icons/folder";
  import Plus from "@lucide/svelte/icons/plus";
  import { app, go, rpc } from "../lib/state.svelte";

  let name = $state("");
  let error = $state("");

  async function create(event: SubmitEvent) {
    event.preventDefault();
    error = "";
    try {
      const project = await rpc.request("projects.create", { name });
      name = "";
      go({ view: "project", name: project.name });
    } catch (cause) {
      error = (cause as Error).message;
    }
  }

  const threadCounts = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const thread of app.threads.filter((thread) => thread.archivedAt === null)) counts.set(thread.project, (counts.get(thread.project) ?? 0) + 1);
    return counts;
  });
</script>

<div class="page">
  <div class="page-inner">
    <div class="page-header">
      <h1>Projects</h1>
      <p class="muted">Each thread gets a workspace with every repository checked out side by side.</p>
    </div>

    <section class="card">
      <div class="section-label">All projects <span class="count">{app.projects.length}</span></div>
      <div class="list">
        {#each app.projects as project (project.name)}
          <button class="list-row" onclick={() => go({ view: "project", name: project.name })}>
            <Folder size={16} class="muted" />
            <span class="name">{project.name}</span>
            <span class="muted truncate grow">
              {project.repos.map((repo) => repo.name).join(", ") || "No repositories yet"}
            </span>
            <span class="chip">{threadCounts.get(project.name) ?? 0} threads</span>
            <ChevronRight size={14} class="muted" />
          </button>
        {:else}
          <p class="muted empty">No projects yet.</p>
        {/each}
      </div>
      <form class="create" onsubmit={create}>
        <input bind:value={name} placeholder="New project name, e.g. doofcraft" required />
        <button class="primary" type="submit"><Plus size={14} />Create</button>
      </form>
      {#if error}<p class="error">{error}</p>{/if}
    </section>
  </div>
</div>

<style>
  .name {
    font-weight: var(--weight-medium);
  }
  .empty {
    padding: var(--space-2);
  }
  .create {
    display: flex;
    gap: var(--space-2);
  }
  .create input {
    flex: 1;
  }
</style>
