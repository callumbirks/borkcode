<script lang="ts">
  import type { Thread } from "shared/protocol";
  import { app, go, nav } from "../lib/state.svelte";

  const threadsByProject = $derived.by(() => {
    const groups = new Map<string, Thread[]>();
    for (const thread of [...app.threads].sort((a, b) => b.createdAt - a.createdAt)) {
      const list = groups.get(thread.project) ?? [];
      list.push(thread);
      groups.set(thread.project, list);
    }
    return groups;
  });
</script>

<nav>
  <button class="brand" onclick={() => go({ view: "home" })}>borkcode</button>
  {#each app.projects as project (project.name)}
    <div class="project">
      <button
        class="project-name"
        class:active={nav.route.view === "project" && nav.route.name === project.name}
        onclick={() => go({ view: "project", name: project.name })}
      >
        {project.name}
        <span class="muted">{project.repos.length} repos</span>
      </button>
      {#each threadsByProject.get(project.name) ?? [] as thread (thread.id)}
        <button
          class="thread"
          class:active={nav.route.view === "thread" && nav.route.id === thread.id}
          onclick={() => go({ view: "thread", id: thread.id })}
        >
          <span class="status {thread.status}"></span>
          <span class="title">{thread.title}</span>
          <span class="provider">{thread.provider}</span>
        </button>
      {/each}
    </div>
  {/each}
</nav>

<style>
  nav {
    background: var(--panel);
    border-right: 1px solid var(--border);
    padding: 12px 8px;
    overflow-y: auto;
  }
  button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-radius: 6px;
    padding: 5px 8px;
  }
  button:hover,
  button.active {
    background: var(--panel-2);
  }
  .brand {
    font-weight: 700;
    font-size: 15px;
    margin-bottom: 12px;
  }
  .project {
    margin-bottom: 12px;
  }
  .project-name {
    font-weight: 600;
    justify-content: space-between;
  }
  .project-name .muted {
    font-weight: 400;
    font-size: 12px;
  }
  .thread {
    padding-left: 16px;
    font-size: 13px;
  }
  .title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .provider {
    font-size: 11px;
    color: var(--muted);
  }
  .status {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--border);
  }
  .status.running,
  .status.preparing {
    background: var(--accent);
  }
  .status.error {
    background: var(--danger);
  }
</style>
