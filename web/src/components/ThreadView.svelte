<script lang="ts">
  import Archive from "@lucide/svelte/icons/archive";
  import ArchiveRestore from "@lucide/svelte/icons/archive-restore";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
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
  import { untrack } from "svelte";
  import type { AccessMode, Effort } from "shared/protocol";
  import { isUnread, providerLabel } from "../lib/display.svelte";
  import { composerAttachments } from "../lib/attachments";
  import {
    attachFiles,
    pendingAttachments,
    releaseAttachments,
    restoreAttachments,
    takeAttachments,
  } from "../lib/composerAttachments.svelte";
  import { forgetMissing, previews } from "../lib/filePreview.svelte";
  import { referenceRoots } from "../lib/fileReferences";
  import { answer, pick } from "../lib/questions";
  import { segmentItems, type Segment } from "../lib/segments";
  import { app, getDraft, go, openThread, rpc, setDraft } from "../lib/state.svelte";
  import AttachButton from "./AttachButton.svelte";
  import ComposerAttachments from "./ComposerAttachments.svelte";
  import ComposerEditor from "./ComposerEditor.svelte";
  import FilePreview from "./FilePreview.svelte";
  import ItemView from "./ItemView.svelte";
  import MentionPicker from "./MentionPicker.svelte";
  import ComposerOptions from "./ComposerOptions.svelte";
  import RepoPanel from "./RepoPanel.svelte";
  import VisualizationPanel from "./VisualizationPanel.svelte";
  import WorkGroup from "./WorkGroup.svelte";

  let { id, compact = false }: { id: string; compact?: boolean } = $props();

  const detail = $derived(app.detail?.thread.id === id ? app.detail : null);
  const thread = $derived(detail?.thread);
  const busy = $derived(thread?.status === "running" || thread?.status === "preparing");
  const parent = $derived(thread?.parentId ? app.threads.find((other) => other.id === thread.parentId) : undefined);

  // Consecutive tool calls and reasoning fold into one group; messages and notices stand alone.
  let lastSegments: Segment[] = [];
  const segments = $derived((lastSegments = segmentItems(detail?.items ?? [], lastSegments)));

  const preview = $derived(previews[id]);
  // Files may have appeared since paths in this thread were last looked up.
  $effect(() => {
    const threadId = id;
    untrack(() => forgetMissing(threadId));
  });

  // Each thread keeps its own unsent text, since this component stays mounted across threads.
  const draft = $derived(getDraft(id));
  const attached = $derived(composerAttachments(pendingAttachments(id)));
  const canSend = $derived((draft.trim() !== "" || attached.ids.length > 0) && attached.ready);
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

  let overview = $state(false);

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

  // A thread is read once it has been open in a visible tab for a few seconds, so a misclick
  // doesn't count. Switching threads, hiding the tab or a new response starts the wait again.
  const unreadSince = $derived(thread && isUnread(thread) ? thread.respondedAt : null);
  let tabVisible = $state(document.visibilityState === "visible");
  $effect(() => {
    const update = () => (tabVisible = document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  });
  $effect(() => {
    if (unreadSince === null || !tabVisible) return;
    const threadId = id;
    const timer = setTimeout(() => rpc.request("threads.markRead", { threadId }).catch(() => undefined), 3000);
    return () => clearTimeout(timer);
  });

  // Pin the transcript to the bottom, including when a thread opens, until the user scrolls up.
  // Watching size rather than items also follows growth that isn't a new item: streamed tool
  // output, expanded groups, late layout.
  // WebKit's parser may report overflow-anchor support even where anchoring is ineffective.
  const skippedItems = CSS.supports("overflow-anchor", "auto") &&
    !CSS.supports("-webkit-touch-callout", "none") &&
    !(/AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg|OPR|Android/.test(navigator.userAgent));
  let pinned = true;
  let lastScrollTop = 0;
  let touchingTranscript = false;
  $effect(() => {
    const element = transcript;
    const column = element?.firstElementChild;
    if (!element || !column) return;
    pinned = true;
    lastScrollTop = 0;
    const observer = new ResizeObserver(() => {
      if (pinned && !touchingTranscript) element.scrollTop = element.scrollHeight;
    });
    observer.observe(column);
    observer.observe(element);
    return () => observer.disconnect();
  });

  // Scroll intent unpins before resizing can fight the gesture. Scroll events fire a frame
  // late, so distance alone would also unpin on a large block landing after our own scroll.
  function onTranscriptScroll() {
    if (!transcript) return;
    const { scrollTop, scrollHeight, clientHeight } = transcript;
    // Upward movement wins even within the bottom threshold, including touch momentum
    // delivered after touchend. Re-pin only on a downward return to the bottom.
    if (scrollTop < lastScrollTop) pinned = false;
    else if (!touchingTranscript && scrollHeight - scrollTop - clientHeight < 80) pinned = true;
    lastScrollTop = scrollTop;
  }

  // A pending question takes over the composer: number keys pick options and typed text is a
  // free-text answer. Several questions are answered one after another, then sent together.
  const asking = $derived(detail?.questions[0] ?? null);
  let step = $state(0);
  let picks = $state<number[][]>([]);
  let typed = $state<string[]>([]);
  let collapsed = $state(false);
  let askingId: string | null = null;
  $effect(() => {
    if ((asking?.id ?? null) === askingId) return;
    askingId = asking?.id ?? null;
    step = 0;
    picks = asking?.questions.map(() => []) ?? [];
    typed = asking?.questions.map(() => "") ?? [];
    collapsed = false;
  });
  const question = $derived(asking?.questions[step]);
  const lastStep = $derived(!asking || step === asking.questions.length - 1);
  const currentAnswer = $derived(question ? answer(question, picks[step] ?? [], draft) : []);

  function choose(index: number) {
    if (!question) return;
    picks[step] = pick(question, picks[step] ?? [], index);
  }

  /** Moves to another question, keeping what was typed for each. */
  function goToStep(next: number) {
    typed[step] = draft;
    step = next;
    setDraft(id, typed[step] ?? "");
  }

  async function submitAnswer() {
    if (!asking || currentAnswer.length === 0) return;
    if (!lastStep) return goToStep(step + 1);
    typed[step] = draft;
    const answers = asking.questions.map((each, index) => answer(each, picks[index] ?? [], typed[index] ?? ""));
    if (answers.some((each) => each.length === 0)) {
      error = "Answer every question first.";
      return;
    }
    error = "";
    try {
      await rpc.request("questions.answer", { threadId: id, questionId: asking.id, answers });
      setDraft(id, "");
    } catch (cause) {
      error = (cause as Error).message;
    }
  }

  // Digits pick options while nothing is typed; once the user types, they are part of the answer.
  function onWindowKeydown(event: KeyboardEvent) {
    if (!question || event.ctrlKey || event.metaKey || event.altKey || !/^[1-9]$/.test(event.key)) return;
    const target = event.target as HTMLElement | null;
    const inComposer = target?.dataset.composer !== undefined;
    if (!inComposer && target?.closest("input, textarea, select, [contenteditable]")) return;
    if (inComposer && draft) return;
    event.preventDefault();
    choose(Number(event.key) - 1);
  }

  // While the agent works, a message joins its turn at the next step or waits for the turn to end.
  async function send() {
    const threadId = id;
    const text = draft.trim();
    if (!canSend) return;
    const attachments = attached.ids;
    error = "";
    setDraft(threadId, "");
    const pending = takeAttachments(threadId);
    try {
      await rpc.request("threads.send", { threadId, text, attachments, model, effort, accessMode });
      releaseAttachments(pending);
    } catch (cause) {
      setDraft(threadId, text);
      restoreAttachments(threadId, pending);
      error = (cause as Error).message;
    }
  }

  // Pasted or dropped images join the message; text pasted alongside them still pastes.
  function onPaste(event: ClipboardEvent) {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    if (!event.clipboardData?.types.includes("text/plain")) event.preventDefault();
    attachFiles(id, files);
  }

  let dragging = $state(false);
  function onDragOver(event: DragEvent) {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    dragging = true;
  }
  function onDrop(event: DragEvent) {
    dragging = false;
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length === 0) return;
    event.preventDefault();
    attachFiles(id, files);
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

  let composer = $state<ComposerEditor>();
  // The thread is replaced on every update. Depending on its project name alone keeps the roots,
  // and with them the composer and every message, from redrawing each time.
  const projectName = $derived(thread?.project);
  const fileRoots = $derived(
    referenceRoots(app.projects.find((project) => project.name === projectName), detail?.workspacePath),
  );
  let mentions = $state<MentionPicker>();

  function onKeydown(event: KeyboardEvent) {
    if (mentions?.keydown(event)) return;
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !(event.target instanceof HTMLTextAreaElement)) {
      event.preventDefault();
      void (asking ? submitAnswer() : send());
    }
  }

  async function respond(approvalId: string, allow: boolean) {
    await rpc.request("approvals.respond", { threadId: id, approvalId, allow }).catch(() => undefined);
  }

  async function setArchived(archived: boolean) {
    error = "";
    await rpc.request("threads.archive", { threadId: id, archived }).catch((cause: Error) => (error = cause.message));
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

<svelte:window onkeydown={onWindowKeydown} />

{#if !detail || !thread}
  <div class="page muted">Loading thread…</div>
{:else}
  <div class="thread" class:previewing={preview}>
    <div class="chat" inert={compact && !!(preview || overview)}>
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
          {#if thread.archivedAt}
            <a class="chip" href="#/archived" title="Hidden from the sidebar and project page">
              <Archive size={12} />Archived
            </a>
          {/if}
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
        {#if thread.archivedAt}
          <button class="ghost icon archive" title="Unarchive thread" onclick={() => setArchived(false)}>
            <ArchiveRestore size={16} />
          </button>
        {:else}
          <button
            class="ghost icon archive"
            title={busy ? "Stop the thread to archive it" : "Archive thread and the threads it started"}
            disabled={busy}
            onclick={() => setArchived(true)}
          >
            <Archive size={16} />
          </button>
        {/if}
        <button class="overview-button ghost" onclick={() => overview = true}>Overview</button>
        <button class="ghost icon delete" title="Delete thread" onclick={remove}><Trash2 size={16} /></button>
      </header>
      <div class="transcript" role="region" aria-label="Thread transcript" bind:this={transcript} onscroll={onTranscriptScroll}
        onwheel={(event) => { if (event.deltaY < 0) pinned = false; }}
        ontouchstart={() => { touchingTranscript = true; pinned = false; }}
        ontouchend={() => { touchingTranscript = false; }} ontouchcancel={() => { touchingTranscript = false; }}>
        <div class="column" class:skipped-items={skippedItems}>
          {#each segments as segment (segment.kind === "item" ? segment.item.id : segment.id)}
            {#if segment.kind === "item"}
              <ItemView item={segment.item} threadId={id} roots={fileRoots} />
            {:else}
              <WorkGroup items={segment.items} threadId={id} roots={fileRoots} />
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
          {:else if thread.status === "running" && !thread.waiting}
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
        {#if asking && question}
          <div class="question" class:collapsed>
            <button class="question-head ghost" onclick={() => (collapsed = !collapsed)} title={collapsed ? "Show options" : "Hide options"}>
              <span class="question-header truncate">{question.header}</span>
              {#if asking.questions.length > 1}<span class="question-step">{step + 1} of {asking.questions.length}</span>{/if}
              {#if question.multiSelect}<span class="question-step">Pick any</span>{/if}
              <ChevronDown size={14} />
            </button>
            <div class="question-text">{question.question}</div>
            {#if !collapsed}
              {#each question.options as option, index (index)}
                <button class="option ghost" class:picked={picks[step]?.includes(index)} onclick={() => choose(index)}>
                  <span class="option-text">
                    <span class="option-label">{option.label}</span>
                    {#if option.description}<span class="option-description">{option.description}</span>{/if}
                  </span>
                  {#if index < 9}<kbd>{index + 1}</kbd>{/if}
                </button>
              {/each}
            {/if}
          </div>
        {/if}
        <div
          class="composer"
          class:dragging
          role="group"
          ondragover={onDragOver}
          ondragleave={() => (dragging = false)}
          ondrop={onDrop}
        >
          <MentionPicker bind:this={mentions} threadId={id} editor={composer} text={draft} />
          <ComposerAttachments threadId={id} />
          <ComposerEditor
            bind:this={composer}
            value={draft}
            roots={fileRoots}
            onchange={(text) => setDraft(id, text)}
            onkeydown={onKeydown}
            onpaste={onPaste}
            placeholder={question
              ? question.options.length === 0
                ? "Type your answer"
                : question.multiSelect
                  ? "Type your own answer, or leave this blank to use the selected options"
                  : "Type your own answer, or leave this blank to use the selected option"
              : busy
                ? "Message the agent; it reads this at its next step"
                : "Message the agent"}
          />
          <div class="actions" class:answering={!!asking}>
            <span class="attachment-control"><AttachButton threadId={id} /></span>
            <ComposerOptions provider={thread.provider} bind:model bind:effort bind:accessMode />
            <span class="spacer"></span>
            {#if thread.workspace}
              <button
                class="ghost publish"
                aria-label="Push and open pull requests"
                onclick={publish}
                disabled={busy}
                title="Ask the agent to commit, push and open pull requests"
              >
                <GitPullRequestArrow size={16} /><span>Push &amp; PR</span>
              </button>
            {/if}
            {#if thread.status === "running"}
              <button class="icon" aria-label="Stop" title="Stop" onclick={() => rpc.request("threads.interrupt", { threadId: id })}>
                <Square size={12} fill="currentColor" />
              </button>
            {/if}
            {#if asking}
              {#if step > 0}<button class="ghost" onclick={() => goToStep(step - 1)}>Back</button>{/if}
              <button class="primary answer" onclick={submitAnswer} disabled={currentAnswer.length === 0}>
                {lastStep ? "Submit answer" : "Next"}
              </button>
            {:else if thread.status !== "running" || draft.trim() || attached.ids.length > 0}
              <button class="primary icon" aria-label="Send" title="Send (Enter)" onclick={send} disabled={!canSend}>
                <ArrowUp size={16} />
              </button>
            {/if}
          </div>
        </div>
      </div>
    </div>
    <div class="side-sheet" class:show={preview || overview}>
    {#if !preview}<button class="overview-close ghost" onclick={() => overview = false}>Close overview</button>{/if}
    <!-- The preview takes the overview's place while it is open. -->
    {#if preview && "visualization" in preview}
      <VisualizationPanel threadId={id} id={preview.visualization} />
    {:else if preview}
      <FilePreview threadId={id} target={preview} />
    {:else}
      <RepoPanel
        threadId={id}
        status={thread.status}
        workspacePath={detail.workspacePath}
        pullRequests={app.pullRequests[detail.thread.id] ?? []}
      />
    {/if}
    </div>
  </div>
{/if}

<style>
  .thread {
    display: grid;
    grid-template-columns: 1fr var(--panel-width);
    height: 100%;
    min-height: 0;
  }
  .thread.previewing {
    grid-template-columns: minmax(0, 1fr) auto;
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
  .archive {
    margin-left: auto;
    flex-shrink: 0;
  }
  .delete {
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
  /*
   * Long transcripts made every keystroke in the composer pay for painting and hit-testing the
   * whole transcript. Off-screen items skip rendering; each remembers its size once laid out.
   */
  .column.skipped-items > :global(*) {
    content-visibility: auto;
    contain-intrinsic-size: auto 120px;
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
  .question {
    display: flex;
    flex-direction: column;
    gap: var(--space-0-5);
    margin-bottom: calc(-1 * var(--radius-xl));
    padding: var(--space-2) var(--space-3) calc(var(--radius-xl) + var(--space-2));
    background: var(--surface-overlay);
    border: 1px solid var(--border-subtle);
    border-bottom: none;
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    max-height: 50vh;
    overflow-y: auto;
  }
  .question-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .question-header {
    flex: 1;
    text-align: left;
  }
  .question-step {
    flex-shrink: 0;
    color: var(--text-faint);
  }
  .question.collapsed .question-head :global(svg) {
    transform: rotate(180deg);
  }
  .question-text {
    margin-bottom: var(--space-1);
    color: var(--text-primary);
  }
  .option {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-1-5) var(--space-2);
    border: 1px solid transparent;
    text-align: left;
  }
  .option.picked {
    border-color: var(--accent);
    background: var(--surface-hover);
  }
  .option-text {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .option-label {
    color: var(--text-primary);
  }
  .option-description {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  kbd {
    flex-shrink: 0;
    font-family: inherit;
    font-size: var(--text-2xs);
    color: var(--text-faint);
  }
  .actions .answer {
    border-radius: var(--radius-full);
  }
  .composer {
    position: relative;
    background: var(--surface-raised);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-md);
    padding: var(--space-2-5) var(--space-3) var(--space-2);
  }
  .composer:focus-within,
  .composer.dragging {
    border-color: var(--border-strong);
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
  .attachment-control { display: contents; }

  .side-sheet {
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .side-sheet > :global(aside) {
    flex: 1;
    min-height: 0;
  }
  .overview-button, .overview-close {
    display: none;
  }
  @media (max-width: 900px) {
    .thread, .thread.previewing {
      grid-template-columns: minmax(0, 1fr);
      flex: 1;
      min-height: 0;
      position: relative;
    }
    header {
      padding: 0 8px;
      height: auto;
      min-height: 44px;
      flex-wrap: wrap;
      gap: 2px;
    }
    header .title {
      flex: 1;
    }
    .chips {
      order: 2;
      flex-basis: 100%;
      padding-bottom: 4px;
      overflow-x: auto;
    }
    .overview-button, .overview-close {
      display: inline-flex;
    }
    .side-sheet {
      display: none;
    }
    .side-sheet.show {
      display: flex;
      position: absolute;
      inset: 0;
      z-index: 20;
      background: var(--surface-base);
    }
    .side-sheet :global(aside) {
      width: 100% !important;
      border-left: 0;
    }
    .side-sheet :global(.resize) {
      display: none;
    }
    .side-sheet :global(header) {
      min-height: 44px;
    }
    .side-sheet :global(a.button) {
      width: 40px;
      height: 40px;
    }
    .transcript {
      padding: 12px;
      overscroll-behavior: contain;
    }
    .composer-wrap {
      flex-shrink: 0;
      padding: 4px 8px 8px;
      max-height: 75%;
    }
    .composer {
      padding: 8px;
    }
    .actions {
      flex-wrap: nowrap;
      gap: 4px;
    }
    .publish { min-width: 40px; min-height: 40px; padding: 4px; }
    .publish span { display: none; }
    .answering .attachment-control, .answering .publish { display: none; }
    .answering .answer { flex-shrink: 0; }
    .actions .spacer {
      display: none;
    }
    .question {
      max-height: 25vh;
    }
    .option {
      min-height: 44px;
    }
  }
</style>
