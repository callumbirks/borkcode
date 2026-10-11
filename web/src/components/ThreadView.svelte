<script lang="ts">
  import { tick } from "svelte";
  import { app, go, openThread, rpc } from "../lib/state.svelte";
  import ItemView from "./ItemView.svelte";
  import RepoPanel from "./RepoPanel.svelte";

  let { id }: { id: string } = $props();

  const detail = $derived(app.detail?.thread.id === id ? app.detail : null);
  const thread = $derived(detail?.thread);
  const busy = $derived(thread?.status === "running" || thread?.status === "preparing");

  let draft = $state("");
  let error = $state("");
  let transcript: HTMLDivElement | undefined = $state();

  $effect(() => {
    if (app.connected) void openThread(id);
  });

  // Follow new output while the user is at the bottom of the transcript.
  const lastItem = $derived(detail?.items.at(-1));
  const progress = $derived(
    `${detail?.items.length}:${lastItem && "text" in lastItem ? lastItem.text.length : 0}:${detail?.approvals.length}`,
  );
  $effect.pre(() => {
    void progress;
    const element = transcript;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    if (atBottom) void tick().then(() => element.scrollTo({ top: element.scrollHeight }));
  });

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    error = "";
    draft = "";
    try {
      await rpc.request("threads.send", { threadId: id, text });
    } catch (cause) {
      draft = text;
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
        <div>
          <strong>{thread.title}</strong>
          <span class="muted">
            {thread.provider}{thread.model ? ` · ${thread.model}` : ""} ·
            {thread.accessMode === "full" ? "full access" : "asks first"} ·
            <a href="#/project/{encodeURIComponent(thread.project)}">{thread.project}</a>
          </span>
        </div>
        <button class="danger" onclick={remove}>Delete</button>
      </header>
      <div class="transcript" bind:this={transcript}>
        {#each detail.items as item (item.id)}
          <ItemView {item} />
        {/each}
        {#each detail.approvals as approval (approval.id)}
          <div class="approval">
            <strong>{approval.title}</strong>
            {#if approval.detail}<pre>{approval.detail}</pre>{/if}
            <div class="row">
              <button class="primary" onclick={() => respond(approval.id, true)}>Allow</button>
              <button onclick={() => respond(approval.id, false)}>Deny</button>
            </div>
          </div>
        {/each}
        {#if thread.status === "preparing"}
          <p class="muted">Creating worktrees and running setup…</p>
        {:else if thread.status === "running" && detail.approvals.length === 0}
          <p class="muted">Working…</p>
        {/if}
      </div>
      <div class="composer">
        {#if error}<p class="error">{error}</p>{/if}
        <textarea
          bind:value={draft}
          onkeydown={onKeydown}
          rows="3"
          placeholder={busy ? "The agent is working…" : "Message the agent (Enter to send, Shift+Enter for a new line)"}
        ></textarea>
        <div class="actions">
          {#if thread.status === "running"}
            <button onclick={() => rpc.request("threads.interrupt", { threadId: id })}>Stop</button>
          {/if}
          <button class="primary" onclick={send} disabled={busy || !draft.trim()}>Send</button>
        </div>
      </div>
    </div>
    <RepoPanel threadId={id} status={thread.status} workspacePath={detail.workspacePath} />
  </div>
{/if}

<style>
  .thread {
    display: grid;
    grid-template-columns: 1fr 320px;
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
    justify-content: space-between;
    align-items: center;
    padding: 10px 20px;
    border-bottom: 1px solid var(--border);
  }
  header .muted {
    margin-left: 8px;
    font-size: 13px;
  }
  .transcript {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
  }
  .approval {
    border: 1px solid var(--warn);
    background: var(--warn-bg);
    border-radius: 8px;
    padding: 12px;
    margin: 8px 0;
  }
  .approval pre {
    white-space: pre-wrap;
    word-break: break-word;
  }
  .composer {
    border-top: 1px solid var(--border);
    padding: 12px 20px;
  }
  textarea {
    width: 100%;
    resize: vertical;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 8px;
  }
</style>
