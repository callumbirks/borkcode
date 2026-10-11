<script lang="ts">
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import CornerDownRight from "@lucide/svelte/icons/corner-down-right";
  import Crown from "@lucide/svelte/icons/crown";
  import Eye from "@lucide/svelte/icons/eye";
  import Inbox from "@lucide/svelte/icons/inbox";
  import Folder from "@lucide/svelte/icons/folder";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import GitPullRequestArrow from "@lucide/svelte/icons/git-pull-request-arrow";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import Square from "@lucide/svelte/icons/square";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import type { AccessMode, Effort, Item } from "shared/protocol";
  import { providerLabel } from "../lib/display.svelte";
  import { app, getDraft, go, openThread, rpc, setDraft } from "../lib/state.svelte";
  import ItemView from "./ItemView.svelte";
  import ModelPicker from "./ModelPicker.svelte";
  import RepoPanel from "./RepoPanel.svelte";
  import WorkGroup from "./WorkGroup.svelte";

  let { id }: { id: string } = $props();

  const detail = $derived(app.detail?.thread.id === id ? app.detail : null);
  const thread = $derived(detail?.thread);
  const busy = $derived(thread?.status === "running" || thread?.status === "preparing");
  const parent = $derived(thread?.parentId ? app.threads.find((other) => other.id === thread.parentId) : undefined);

  // Consecutive tool calls and reasoning fold into one group; messages and notices stand alone.
  type Segment = { kind: "item"; item: Item } | { kind: "work"; id: string; items: Item[] };
  const segments = $derived.by(() => {
    const result: Segment[] = [];
    for (const item of detail?.items ?? []) {
      const previous = result.at(-1);
      if (item.kind !== "tool" && item.kind !== "reasoning") result.push({ kind: "item", item });
      else if (previous?.kind === "work") previous.items.push(item);
      else result.push({ kind: "work", id: item.id, items: [item] });
    }
    return result;
  });

  // Each thread keeps its own unsent text, since this component stays mounted across threads.
  const draft = $derived(getDraft(id));
  let error = $state("");
  let transcript: HTMLDivElement | undefined = $state();

  // The composer's picks start from the thread's and are saved with the next message. This
  // component stays mounted when switching threads, so reload them for each thread.
  let model = $state<string | null>(null);
  let effort = $state<Effort | null>(null);
  let accessMode = $state<AccessMode>("ask");
  let picksLoadedFor: string | null = null;
  $effect(() => {
    if (!thread || picksLoadedFor === thread.id) return;
    picksLoadedFor = thread.id;
    model = thread.model;
    effort = thread.effort;
    accessMode = thread.accessMode;
  });

  let editingTitle = $state(false);
  let titleDraft = $state("");

  function editTitle() {
    if (!thread) return;
    titleDraft = thread.title;
    editingTitle = true;
  }

  async function saveTitle() {
    if (!editingTitle) return;
    editingTitle = false;
    const title = titleDraft.trim();
    if (!title || title === thread?.title) return;
    try {
      await rpc.request("threads.rename", { threadId: id, title });
    } catch (cause) {
      error = (cause as Error).message;
    }
  }

  function onTitleKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") void saveTitle();
    if (event.key === "Escape") editingTitle = false;
  }

  $effect(() => {
    if (app.connected) void openThread(id);
  });

  // Pin the transcript to the bottom, including when a thread opens, until the user scrolls up.
  // Watching size rather than items also follows growth that isn't a new item: streamed tool
  // output, expanded groups, late layout.
  let pinned = true;
  let lastScrollTop = 0;
  $effect(() => {
    const element = transcript;
    const column = element?.firstElementChild;
    if (!element || !column) return;
    pinned = true;
    lastScrollTop = 0;
    const observer = new ResizeObserver(() => {
      if (pinned) element.scrollTop = element.scrollHeight;
    });
    observer.observe(column);
    observer.observe(element);
    return () => observer.disconnect();
  });

  // Only scrolling up unpins. Scroll events fire a frame late, so judging by distance from the
  // bottom would unpin whenever a large block (an approval, say) lands right after our own scroll.
  function onTranscriptScroll() {
    if (!transcript) return;
    const { scrollTop, scrollHeight, clientHeight } = transcript;
    if (scrollHeight - scrollTop - clientHeight < 80) pinned = true;
    else if (scrollTop < lastScrollTop) pinned = false;
    lastScrollTop = scrollTop;
  }

  // While the agent works, a message joins its turn at the next step or waits for the turn to end.
  async function send() {
    const threadId = id;
    const text = draft.trim();
    if (!text) return;
    error = "";
    setDraft(threadId, "");
    try {
      await rpc.request("threads.send", { threadId, text, model, effort, accessMode });
    } catch (cause) {
      setDraft(threadId, text);
      error = (cause as Error).message;
    }
  }

  async function resume() {
    error = "";
    await rpc.request("threads.resume", { threadId: id }).catch((cause: Error) => (error = cause.message));
  }

  async function publish() {
    if (busy) return;
    error = "";
    try {
      await rpc.request("threads.publish", { threadId: id, model, effort, accessMode });
    } catch (cause) {
      error = (cause as Error).message;
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  async function respond(approvalId: string, allow: boolean) {
    await rpc.request("approvals.respond", { threadId: id, approvalId, allow }).catch(() => undefined);
  }

  async function remove() {
    if (!thread) return;
    const what = thread.workspace ? "this thread and its worktrees (branches are kept)" : "this thread";
    if (!confirm(`Delete ${what}?`)) return;
    try {
      await rpc.request("threads.delete", { threadId: id });
    } catch (cause) {
      const message = (cause as Error).message;
      if (!message.startsWith("Uncommitted changes")) {
        error = message;
        return;
      }
      if (!confirm(`${message}. Delete anyway and lose those changes?`)) return;
      await rpc.request("threads.delete", { threadId: id, force: true });
    }
    go({ view: "project", name: thread.project });
  }
</script>

{#if !detail || !thread}
  <div class="page muted">Loading thread…</div>
{:else}
  <div class="thread">
    <div class="chat">
      <header>
        <span class="dot {thread.status}" title={thread.status}></span>
        {#if editingTitle}
          <!-- svelte-ignore a11y_autofocus -->
          <input class="title" bind:value={titleDraft} onkeydown={onTitleKeydown} onblur={saveTitle} autofocus />
        {:else}
          <button class="title ghost truncate" title="Rename" onclick={editTitle}>{thread.title}</button>
        {/if}
        <div class="chips">
          <a class="chip" href="#/project/{encodeURIComponent(thread.project)}" title="Project">
            <Folder size={12} />{thread.project}
          </a>
          {#if thread.captain}
            <span class="chip" title="Coordinates the threads it starts"><Crown size={12} />Captain</span>
          {/if}
          {#if parent}
            <a
              class="chip"
              href="#/thread/{parent.id}"
              title={thread.watched ? `Reports each turn to ${parent.title}` : `Handed off from ${parent.title}`}
            >
              {#if thread.watched}<Eye size={12} />{:else}<CornerDownRight size={12} />{/if}
              <span class="truncate">{parent.title}</span>
            </a>
          {/if}
          <span class="chip provider-{thread.provider}">{providerLabel[thread.provider]}</span>
          <span class="chip" title={thread.branch ?? "Runs in the main checkouts"}>
            <GitBranch size={12} />{thread.branch ?? "main checkout"}
          </span>
        </div>
        <button class="ghost icon delete" title="Delete thread" onclick={remove}><Trash2 size={16} /></button>
      </header>
      <div class="transcript" bind:this={transcript} onscroll={onTranscriptScroll}>
        <div class="column">
          {#each segments as segment (segment.kind === "item" ? segment.item.id : segment.id)}
            {#if segment.kind === "item"}
              <ItemView item={segment.item} />
            {:else}
              <WorkGroup items={segment.items} />
            {/if}
          {/each}
          {#each detail.approvals as approval (approval.id)}
            <div class="approval">
              <div class="approval-title"><ShieldAlert size={16} />{approval.title}</div>
              {#if approval.detail}<pre>{approval.detail}</pre>{/if}
              <div class="row">
                <button class="primary" onclick={() => respond(approval.id, true)}>Allow</button>
                <button onclick={() => respond(approval.id, false)}>Deny</button>
              </div>
            </div>
          {/each}
          {#if thread.status === "preparing"}
            <p class="status"><span class="dot running"></span>Preparing the workspace…</p>
          {:else if thread.status === "running" && detail.approvals.length === 0}
            <p class="status"><span class="dot running"></span>Working…</p>
          {/if}
        </div>
      </div>
      <div class="composer-wrap">
        {#if error}<p class="error">{error}</p>{/if}
        {#if thread.paused || (thread.queued > 0 && !busy)}
          <div class="waiting">
            <Inbox size={14} />
            <span>
              {#if thread.paused}
                Deliveries between threads are paused after a burst of automatic turns.
              {:else}
                Waiting since the agent was stopped.
              {/if}
              {thread.queued} {thread.queued === 1 ? "message" : "messages"} queued.
            </span>
            <button class="ghost" onclick={resume}>Deliver</button>
          </div>
        {:else if thread.queued > 0}
          <div class="waiting">
            <Inbox size={14} />
            <span>
              {thread.queued} {thread.queued === 1 ? "message reaches" : "messages reach"} the agent at its next
              step or when this turn ends.
            </span>
          </div>
        {/if}
        <div class="composer">
          <textarea
            bind:value={() => draft, (text) => setDraft(id, text)}
            onkeydown={onKeydown}
            rows="2"
            placeholder={busy ? "Message the agent; it reads this at its next step" : "Message the agent"}
          ></textarea>
          <div class="actions">
            <ModelPicker provider={thread.provider} bind:model bind:effort compact />
            <select title="Access, applied from the next message" bind:value={accessMode}>
              <option value="ask">Ask first</option>
              <option value="full">Full access</option>
            </select>
            <span class="spacer"></span>
            {#if thread.workspace}
              <button
                class="ghost"
                onclick={publish}
                disabled={busy}
                title="Ask the agent to commit, push and open pull requests"
              >
                <GitPullRequestArrow size={14} />Push &amp; PR
              </button>
            {/if}
            {#if thread.status === "running"}
              <button class="icon" title="Stop" onclick={() => rpc.request("threads.interrupt", { threadId: id })}>
                <Square size={12} fill="currentColor" />
              </button>
            {/if}
            {#if thread.status !== "running" || draft.trim()}
              <button class="primary icon" title="Send (Enter)" onclick={send} disabled={!draft.trim()}>
                <ArrowUp size={16} />
              </button>
            {/if}
          </div>
        </div>
      </div>
    </div>
    <RepoPanel
      threadId={id}
      status={thread.status}
      workspacePath={detail.workspacePath}
      pullRequests={app.pullRequests[detail.thread.id] ?? []}
    />
  </div>
{/if}

<style>
  .thread {
    display: grid;
    grid-template-columns: 1fr var(--panel-width);
    height: 100%;
    min-height: 0;
  }
  .chat {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    height: var(--header-height);
    padding: 0 var(--space-3) 0 var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
  }
  .title {
    min-width: 0;
    font-weight: var(--weight-semibold);
    font-size: var(--text-sm);
    color: var(--text-primary);
    padding: var(--space-0-5) var(--space-1-5);
  }
  button.title {
    display: block;
    flex-shrink: 1;
  }
  input.title {
    flex: 1;
  }
  .chips {
    display: flex;
    gap: var(--space-1);
    min-width: 0;
    overflow: hidden;
  }
  a.chip:hover {
    color: var(--text-primary);
    text-decoration: none;
  }
  .delete {
    margin-left: auto;
    flex-shrink: 0;
  }
  .delete:hover:not(:disabled) {
    color: var(--status-danger);
  }
  .transcript {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-6) var(--space-6) var(--space-4);
  }
  .column {
    max-width: var(--content-width);
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .status {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .approval {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    border: 1px solid var(--status-warning);
    background: var(--status-warning-soft);
    border-radius: var(--radius-lg);
    padding: var(--space-3);
  }
  .approval-title {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-weight: var(--weight-semibold);
    color: var(--status-warning);
  }
  .approval pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-secondary);
  }
  .composer-wrap {
    padding: 0 var(--space-6) var(--space-4);
  }
  .composer-wrap > * {
    max-width: var(--content-width);
    margin-left: auto;
    margin-right: auto;
  }
  .composer-wrap .error {
    margin-bottom: var(--space-2);
  }
  .waiting {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
    padding: var(--space-1-5) var(--space-3);
    border-radius: var(--radius-md);
    background: var(--surface-overlay);
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }
  .waiting span {
    flex: 1;
  }
  .composer {
    background: var(--surface-raised);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-md);
    padding: var(--space-2-5) var(--space-3) var(--space-2);
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
    max-height: 240px;
    field-sizing: content;
    min-height: 44px;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    margin-top: var(--space-2);
  }
  .spacer {
    flex: 1;
  }
  .actions .icon {
    border-radius: var(--radius-full);
  }
  /* Matches ModelPicker's compact selects beside it. */
  .actions select {
    background: none;
    border-color: transparent;
    color: var(--text-secondary);
    padding: var(--space-1) var(--space-1-5);
  }
  .actions select:hover {
    background: var(--surface-hover);
    color: var(--text-primary);
  }
  .actions select:focus {
    border-color: transparent;
  }
</style>
