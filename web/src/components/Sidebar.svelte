<script lang="ts">
  import Archive from "@lucide/svelte/icons/archive";
  import ArchiveRestore from "@lucide/svelte/icons/archive-restore";
  import CheckCheck from "@lucide/svelte/icons/check-check";
  import Crown from "@lucide/svelte/icons/crown";
  import Folder from "@lucide/svelte/icons/folder";
  import Inbox from "@lucide/svelte/icons/inbox";
  import LayoutGrid from "@lucide/svelte/icons/layout-grid";
  import ListFilter from "@lucide/svelte/icons/list-filter";
  import Mail from "@lucide/svelte/icons/mail";
  import MailOpen from "@lucide/svelte/icons/mail-open";
  import Plus from "@lucide/svelte/icons/plus";
  import Settings from "@lucide/svelte/icons/settings";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import type { Thread } from "shared/protocol";
  import {
    isUnread,
    providerLabel,
    pullRequestIcon,
    pullRequestState,
    relativeTime,
    type PullRequestState,
  } from "../lib/display.svelte";
  import { longPress } from "../lib/longPress";
  import { filterThreads, isDefaultFilter, parseFilter, type SidebarFilter } from "../lib/sidebarFilter";
  import { deleteThread } from "../lib/threadActions";
  import { workingInSubtree } from "../lib/threadTree";
  import { app, go, nav, rpc } from "../lib/state.svelte";
  import ContextMenu, { type MenuItem } from "./ContextMenu.svelte";
  import FilterMenu from "./FilterMenu.svelte";
  import Spinner from "./Spinner.svelte";

  // The filter belongs to this device, like drafts.
  const filterKey = "borkcode.sidebarFilter";
  let filter = $state.raw(parseFilter(localStorage.getItem(filterKey)));
  let filterAnchor = $state.raw<HTMLElement | null>(null);
  // Projects whose inactive threads were revealed from the "hidden" line, until the next reload.
  let revealed = $state.raw(new Set<string>());

  function setFilter(next: SidebarFilter) {
    filter = next;
    localStorage.setItem(filterKey, JSON.stringify(next));
  }

  function toggleRevealed(project: string) {
    const next = new Set(revealed);
    if (!next.delete(project)) next.add(project);
    revealed = next;
  }

  const shownProjects = $derived(app.projects.filter((project) => !filter.excludedProjects.includes(project.name)));

  // Threads nest under the thread that started them, and every level sorts by recent activity.
  // Archived threads are listed only on the Archived page. The open thread and the one whose
  // menu is open stay listed through the filter, so they don't vanish while in use.
  const filtered = $derived.by(() => {
    const keep = [nav.route.view === "thread" ? nav.route.id : "", menu?.threadId ?? ""];
    return filterThreads(
      app.threads.filter((thread) => thread.archivedAt === null).sort((a, b) => b.updatedAt - a.updatedAt),
      { filter, pullRequests: app.pullRequests, keep, showInactiveIn: revealed },
    );
  });

  const threadsByProject = $derived.by(() => {
    const visible = filtered.shown;
    const children = new Map<string, Thread[]>();
    for (const thread of visible) {
      if (thread.parentId) children.set(thread.parentId, [...(children.get(thread.parentId) ?? []), thread]);
    }
    const ids = new Set(visible.map((thread) => thread.id));
    const groups = new Map<string, { thread: Thread; depth: number }[]>();
    const add = (thread: Thread, depth: number) => {
      const list = groups.get(thread.project) ?? [];
      list.push({ thread, depth });
      groups.set(thread.project, list);
      for (const child of children.get(thread.id) ?? []) add(child, depth + 1);
    };
    for (const thread of visible) {
      if (!thread.parentId || !ids.has(thread.parentId)) add(thread, 0);
    }
    return groups;
  });

  const archivedCount = $derived(app.threads.filter((thread) => thread.archivedAt !== null).length);

  let menu = $state.raw<{ x: number; y: number; items: MenuItem[]; threadId?: string } | null>(null);

  const setRead = (threadId: string, read: boolean) => void rpc.request("threads.setRead", { threadId, read }).catch(() => undefined);

  // The sidebar has nowhere to show an error, so a refusal the menu could not foresee is an alert.
  const report = (cause: Error) => alert(cause.message);

  function threadItems(thread: Thread): MenuItem[] {
    const working = workingInSubtree(app.threads, thread.id);
    return [
      isUnread(thread)
        ? { label: "Mark as read", icon: MailOpen, run: () => setRead(thread.id, true) }
        : { label: "Mark as unread", icon: Mail, run: () => setRead(thread.id, false) },
      thread.archivedAt
        ? { label: "Unarchive", icon: ArchiveRestore, run: () => setArchived(thread.id, false) }
        : {
            label: "Archive",
            icon: Archive,
            run: () => setArchived(thread.id, true),
            disabled: !working ? undefined : working.id === thread.id ? "Stop it to archive" : `Wait for "${working.title}"`,
          },
      { label: "Delete", icon: Trash2, danger: true, run: () => void deleteThread(thread).catch(report) },
    ];
  }

  function setArchived(threadId: string, archived: boolean) {
    void rpc.request("threads.archive", { threadId, archived }).catch(report);
  }

  function projectItems(threads: { thread: Thread }[]): MenuItem[] {
    const unread = threads.filter(({ thread }) => isUnread(thread));
    if (unread.length === 0) return [];
    return [{ label: "Mark all as read", icon: CheckCheck, run: () => unread.forEach(({ thread }) => setRead(thread.id, true)) }];
  }

  /** Right-click, or the context menu key, which reports no pointer position, so the menu opens under the row. */
  function openMenu(event: MouseEvent, items: () => MenuItem[], threadId?: string) {
    event.preventDefault();
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    showMenu(fromKeyboard ? rect.left : event.clientX, fromKeyboard ? rect.bottom : event.clientY, items, threadId);
  }

  function showMenu(x: number, y: number, items: () => MenuItem[], threadId?: string) {
    const list = items();
    menu = list.length > 0 ? { x, y, items: list, threadId } : null;
  }

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

  <div class="threads-header">
    <span>Threads</span>
    <button
      class="filter ghost icon"
      class:filtered={!isDefaultFilter(filter)}
      aria-label="Filter threads"
      aria-haspopup="dialog"
      aria-expanded={filterAnchor !== null}
      title={isDefaultFilter(filter) ? "Filter threads" : "Filter threads (changed from the defaults)"}
      onclick={(event) => (filterAnchor = filterAnchor ? null : event.currentTarget)}
    >
      <ListFilter size={14} />
    </button>
  </div>

  <div class="threads">
    {#if shownProjects.length === 0 && app.projects.length > 0}
      <button class="more ghost" onclick={() => setFilter({ ...filter, excludedProjects: [] })}>
        All projects hidden · Show all
      </button>
    {/if}
    {#each shownProjects as project (project.name)}
      {@const threads = threadsByProject.get(project.name) ?? []}
      {@const hidden = filtered.hidden.get(project.name) ?? 0}
      <div class="group">
        <div class="group-header" class:active={nav.route.view === "project" && nav.route.name === project.name}>
          <button
            class="project ghost"
            onclick={() => go({ view: "project", name: project.name })}
            oncontextmenu={(event) => openMenu(event, () => projectItems(threads))}
            {@attach longPress((x, y) => showMenu(x, y, () => projectItems(threads)))}
          >
            <Folder size={14} />
            <span class="truncate">{project.name}</span>
            <span class="count">{threads.length + hidden}</span>
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
          {@const open = nav.route.view === "thread" && nav.route.id === thread.id}
          {@const working = thread.status === "running" || thread.status === "preparing"}
          <!-- The open thread is being read, so it lights up only when marked unread by hand. -->
          {@const unread = isUnread(thread) && !working && (!open || thread.markedUnread)}
          <button
            class="thread ghost"
            class:unread
            style:padding-left="calc(var(--space-2) + {depth} * var(--space-4))"
            class:active={open}
            onclick={() => go({ view: "thread", id: thread.id })}
            oncontextmenu={(event) => openMenu(event, () => threadItems(thread), thread.id)}
            {@attach longPress((x, y) => showMenu(x, y, () => threadItems(thread), thread.id))}
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
                {#if thread.waiting}
                  <span class="time waiting" title="Waiting for your approval or answer">Needs you</span>
                {:else if working}
                  <span class="time"><Spinner label={thread.status === "preparing" ? "Preparing" : "Working"} /></span>
                {:else}
                  <span class="time">
                    {#if unread}<span class="unread-dot" title="Unread"></span>{/if}{relativeTime(thread.updatedAt)}
                  </span>
                {/if}
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
        {#if filter.hideInactive && revealed.has(project.name)}
          <button class="more ghost" onclick={() => toggleRevealed(project.name)}>Hide inactive</button>
        {:else if hidden > 0}
          <button class="more ghost" onclick={() => toggleRevealed(project.name)}>
            {threads.length === 0 ? "No active threads" : `${hidden} hidden`} · Show all
          </button>
        {/if}
      </div>
    {/each}
  </div>

  <button class="link ghost" class:active={nav.route.view === "archived"} onclick={() => go({ view: "archived" })}>
    <Archive size={16} />
    Archived
    {#if archivedCount > 0}<span class="count">{archivedCount}</span>{/if}
  </button>
</nav>

{#if menu}
  <ContextMenu {...menu} onclose={() => (menu = null)} />
{/if}
{#if filterAnchor}
  <FilterMenu
    anchor={filterAnchor}
    projects={app.projects.map((project) => project.name)}
    {filter}
    onchange={setFilter}
    onclose={() => (filterAnchor = null)}
  />
{/if}

<style>
  /* Its own compositor layer, so sidebar updates don't re-raster the page beside it. */
  nav {
    transform: translateZ(0);
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
  .threads-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: calc(-1 * var(--space-2));
    padding-left: var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-faint);
  }
  .filter {
    position: relative;
    flex-shrink: 0;
    width: 24px !important;
    min-height: 24px;
    color: var(--text-faint);
  }
  /* The filter differs from the defaults, so the list may be missing more than inactive threads. */
  .filter.filtered {
    color: var(--accent);
  }
  .filter.filtered::after {
    content: "";
    position: absolute;
    top: 3px;
    right: 3px;
    width: 6px;
    height: 6px;
    border-radius: var(--radius-full);
    background: var(--accent);
  }
  .more {
    min-height: 24px;
    padding: var(--space-1) var(--space-2);
    font-size: var(--text-2xs);
    color: var(--text-faint);
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
  @media (pointer: coarse), (max-width: 900px) {
    .filter {
      width: 40px !important;
      min-height: 40px;
    }
    .more {
      min-height: 40px;
    }
  }
  /* A long press opens the row's menu, not the browser's callout or a text selection. */
  .project,
  .thread {
    -webkit-touch-callout: none;
    user-select: none;
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
  .time.waiting {
    color: var(--status-warning);
  }
  .unread .title {
    font-weight: var(--weight-semibold);
  }
  .unread .time {
    color: var(--accent);
  }
  .unread-dot {
    display: inline-block;
    margin-right: var(--space-1-5);
    vertical-align: 1px;
    width: 6px;
    height: 6px;
    border-radius: var(--radius-full);
    background: var(--accent);
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
