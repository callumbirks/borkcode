<script lang="ts">
  import Crown from "@lucide/svelte/icons/crown";
  import Folder from "@lucide/svelte/icons/folder";
  import Inbox from "@lucide/svelte/icons/inbox";
  import LayoutGrid from "@lucide/svelte/icons/layout-grid";
  import Plus from "@lucide/svelte/icons/plus";
  import Settings from "@lucide/svelte/icons/settings";
  import type { Thread } from "shared/protocol";
  import {
    providerLabel,
    pullRequestIcon,
    pullRequestState,
    relativeTime,
    type PullRequestState,
  } from "../lib/display.svelte";
  import { app, go, nav } from "../lib/state.svelte";

  // Threads nest under the thread that started them, newest child first; top-level threads sort by
  // recent activity.
  const threadsByProject = $derived.by(() => {
    const children = new Map<string, Thread[]>();
    for (const thread of [...app.threads].sort((a, b) => b.createdAt - a.createdAt)) {
      if (thread.parentId) children.set(thread.parentId, [...(children.get(thread.parentId) ?? []), thread]);
    }
    const ids = new Set(app.threads.map((thread) => thread.id));
    const groups = new Map<string, { thread: Thread; depth: number }[]>();
    const add = (thread: Thread, depth: number) => {
      const list = groups.get(thread.project) ?? [];
      list.push({ thread, depth });
      groups.set(thread.project, list);
      for (const child of children.get(thread.id) ?? []) add(child, depth + 1);
    };
    for (const thread of [...app.threads].sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (!thread.parentId || !ids.has(thread.parentId)) add(thread, 0);
    }
    return groups;
  });

  /** A thread's pull requests counted per state, in a fixed order, leaving out empty states. */
  function prCounts(threadId: string): { state: PullRequestState; count: number }[] {
    const counts = { open: 0, merged: 0, closed: 0 };
    for (const pr of app.pullRequests[threadId] ?? []) counts[pullRequestState(pr)]++;
    return (["open", "merged", "closed"] as const)
      .filter((state) => counts[state] > 0)
      .map((state) => ({ state, count: counts[state] }));
  }
</script>

<nav>
  <button class="brand ghost" onclick={() => go({ view: "home" })}>
    <span class="logo">b</span>
    borkcode
  </button>

  <div class="links">
    <button class="link ghost" class:active={nav.route.view === "home"} onclick={() => go({ view: "home" })}>
      <LayoutGrid size={16} />
      Projects
    </button>
    <button class="link ghost" class:active={nav.route.view === "settings"} onclick={() => go({ view: "settings" })}>
      <Settings size={16} />
      Settings
    </button>
  </div>

  <div class="threads">
    {#each app.projects as project (project.name)}
      {@const threads = threadsByProject.get(project.name) ?? []}
      <div class="group">
        <div class="group-header" class:active={nav.route.view === "project" && nav.route.name === project.name}>
          <button class="project ghost" onclick={() => go({ view: "project", name: project.name })}>
            <Folder size={14} />
            <span class="truncate">{project.name}</span>
            <span class="count">{threads.length}</span>
          </button>
          <button
            class="add ghost icon"
            title="New thread in {project.name}"
            onclick={() => go({ view: "project", name: project.name })}
          >
            <Plus size={14} />
          </button>
        </div>
        {#each threads as { thread, depth } (thread.id)}
          {@const prs = prCounts(thread.id)}
          <button
            class="thread ghost"
            style:padding-left="calc(var(--space-2) + {depth} * var(--space-4))"
            class:active={nav.route.view === "thread" && nav.route.id === thread.id}
            onclick={() => go({ view: "thread", id: thread.id })}
          >
            <span class="dot {thread.status}" title={thread.status}></span>
            <span class="lines">
              <span class="title-row">
                {#if thread.captain}<span class="marker" title="Captain"><Crown size={12} /></span>{/if}
                <span class="title truncate">{thread.title}</span>
                {#if thread.paused || thread.queued > 0}
                  <span
                    class="badge"
                    class:paused={thread.paused}
                    title={thread.paused ? "Deliveries paused; messages waiting" : "Messages waiting"}
                  >
                    <Inbox size={10} />{thread.queued}
                  </span>
                {/if}
                <span class="time">{relativeTime(thread.updatedAt)}</span>
              </span>
              <span class="meta truncate">
                <span class="provider-{thread.provider}">{providerLabel[thread.provider]}</span>
                {#if !thread.workspace}· main checkout{/if}
                {#if prs.length > 0}·{/if}
                {#each prs as { state, count } (state)}
                  {@const Icon = pullRequestIcon[state]}
                  <span class="prs pr-{state}" title="{count} {state} pull request{count === 1 ? '' : 's'}">
                    <Icon size={11} />{count}
                  </span>
                {/each}
              </span>
            </span>
          </button>
        {/each}
      </div>
    {/each}
  </div>
</nav>

<style>
  nav {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    background: var(--surface-sidebar);
    padding: var(--space-3) var(--space-2);
    min-height: 0;
  }
  nav button {
    width: 100%;
    justify-content: flex-start;
    font-weight: var(--weight-regular);
    text-align: left;
  }
  .brand {
    font-weight: var(--weight-semibold);
    color: var(--text-primary);
    gap: var(--space-2);
  }
  .logo {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: var(--radius-md);
    background: var(--accent);
    color: var(--text-on-accent);
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
  }
  .links {
    display: flex;
    flex-direction: column;
  }
  .link {
    gap: var(--space-2-5);
    min-height: 30px;
  }
  .active,
  .active:hover:not(:disabled) {
    background: var(--surface-active);
    color: var(--text-primary);
  }
  .threads {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .group-header {
    display: flex;
    align-items: center;
    border-radius: var(--radius-md);
  }
  .group-header.active {
    background: var(--surface-active);
  }
  .project {
    flex: 1;
    min-width: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .count {
    color: var(--text-faint);
  }
  .add {
    flex-shrink: 0;
    width: 24px !important;
    min-height: 24px;
    color: var(--text-faint);
    opacity: 0;
  }
  .group-header:hover .add,
  .add:focus-visible {
    opacity: 1;
  }
  .thread {
    align-items: flex-start;
    gap: var(--space-2-5);
    padding: var(--space-1-5) var(--space-2);
    color: var(--text-primary);
  }
  .thread .dot {
    margin-top: 6px;
  }
  .lines {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .title-row {
    display: flex;
    gap: var(--space-2);
    align-items: baseline;
  }
  .title {
    flex: 1;
    font-size: var(--text-sm);
  }
  .marker {
    flex-shrink: 0;
    align-self: center;
    color: var(--text-muted);
  }
  .badge {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    font-size: var(--text-2xs);
    color: var(--text-muted);
  }
  .badge.paused {
    color: var(--status-warning);
  }
  .time {
    flex-shrink: 0;
    font-size: var(--text-2xs);
    color: var(--text-faint);
  }
  .meta {
    font-size: var(--text-2xs);
    color: var(--text-faint);
  }
  .prs {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    vertical-align: -1px;
  }
</style>
