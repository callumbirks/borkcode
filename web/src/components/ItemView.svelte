<script lang="ts">
  import Brain from "@lucide/svelte/icons/brain";
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import CornerDownRight from "@lucide/svelte/icons/corner-down-right";
  import GitFork from "@lucide/svelte/icons/git-fork";
  import Info from "@lucide/svelte/icons/info";
  import MessageCircleQuestionMark from "@lucide/svelte/icons/message-circle-question-mark";
  import DOMPurify from "dompurify";
  import { mount, unmount } from "svelte";
  import type { Item } from "shared/protocol";
  import { providerLabel, pullRequestIcon, toolIcon, toolLabel } from "../lib/display.svelte";
  import { renderMarkdown } from "../lib/markdown";
  import { app, go } from "../lib/state.svelte";

  let { item }: { item: Item } = $props();

  /** The other thread a handoff item points at; titles and status stay live as it works. */
  const linked = $derived.by(() => {
    const id = item.kind === "thread" ? item.threadId : item.kind === "user" ? item.fromThreadId : undefined;
    return id ? app.threads.find((thread) => thread.id === id) : undefined;
  });

  /** Lines a message from another thread shows while collapsed; keep in step with `.clip`. */
  const collapsedLines = 5;
  let expanded = $state(false);
  let collapsible = $state(false);

  /** Measures whether the text overflows the collapsed height, again whenever its size changes. */
  function measure(node: HTMLElement) {
    const observer = new ResizeObserver(() => {
      collapsible = node.offsetHeight > collapsedLines * parseFloat(getComputedStyle(node).lineHeight) + 1;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }

  /** Toggles on a click anywhere except a link, and not when the click ended a text selection. */
  function toggle(event: MouseEvent) {
    if (!collapsible || (event.target as Element).closest("a")) return;
    if (window.getSelection()?.toString()) return;
    expanded = !expanded;
  }

  function toggleByKey(event: KeyboardEvent) {
    if (!collapsible || event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    expanded = !expanded;
  }

  /**
   * An attachment that renders markdown, with PR links as chips, and mounts the chips' icons.
   * It reruns when the text or any PR's state changes.
   */
  function markdown(text: string) {
    return (node: HTMLElement) => {
      const html = renderMarkdown(text, Object.values(app.pullRequests).flat());
      node.innerHTML = DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
      const icons = [...node.querySelectorAll<HTMLElement>("[data-pr-state]")].map((target) => {
        const state = target.dataset.prState;
        const Icon = state === "merged" || state === "closed" ? pullRequestIcon[state] : pullRequestIcon.open;
        return mount(Icon, { target, props: { size: 14 } });
      });
      return () => icons.forEach((icon) => unmount(icon));
    };
  }
</script>

{#if item.kind === "user" && item.fromThreadId}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex: it is focusable only while it is a button -->
  <div
    class="user agent"
    class:collapsible
    class:collapsed={collapsible && !expanded}
    role={collapsible ? "button" : undefined}
    tabindex={collapsible ? 0 : undefined}
    aria-expanded={collapsible ? expanded : undefined}
    onclick={toggle}
    onkeydown={toggleByKey}
  >
    <div class="from">
      <CornerDownRight size={12} />
      {#if linked}
        From <a href="#/thread/{linked.id}">{linked.title}</a>
      {:else}
        From a thread that was since deleted
      {/if}
    </div>
    {#if item.steered}<div class="from">Read while working</div>{/if}
    <div class="clip"><div {@attach measure}>{item.text}</div></div>
  </div>
{:else if item.kind === "user"}
  <div class="user">
    {#if item.fromBorkcode}<div class="from"><CornerDownRight size={12} />From borkcode</div>{/if}
    {#if item.steered}<div class="from">Read while working</div>{/if}
    {item.text}
  </div>
{:else if item.kind === "thread"}
  {#if linked}
    <button class="handoff" onclick={() => go({ view: "thread", id: linked.id })}>
      <GitFork size={14} />
      <span class="handoff-label">Started thread</span>
      <span class="truncate">{linked.title}</span>
      <span class="handoff-meta">{providerLabel[linked.provider]}</span>
      <span class="dot {linked.status}" title={linked.status}></span>
    </button>
  {:else}
    <div class="notice"><GitFork size={14} /><span>Started a thread that was since deleted</span></div>
  {/if}
{:else if item.kind === "assistant"}
  {#if item.text}
    <div class="assistant" {@attach markdown(item.text)}></div>
  {/if}
{:else if item.kind === "reasoning"}
  {#if item.text}
    <details class="step">
      <summary>
        <Brain size={14} />
        <span class="name">Thinking</span>
      </summary>
      <div class="body reasoning" {@attach markdown(item.text)}></div>
    </details>
  {/if}
{:else if item.kind === "tool"}
  {@const Icon = toolIcon(item.name)}
  <details class="step {item.status}">
    <summary class:static={!item.output}>
      <Icon size={14} />
      <span class="name">{toolLabel(item.name)}</span>
      <code class="summary truncate">{item.summary}</code>
      {#if item.status === "failed"}<span class="failed-label">failed</span>{/if}
    </summary>
    {#if item.output}<pre class="body">{item.output}</pre>{/if}
  </details>
{:else if item.kind === "question"}
  {@const answers = item.answers}
  {#if answers}
    <div class="asked">
      {#each item.questions as question, index (index)}
        <div class="notice"><MessageCircleQuestionMark size={14} /><span>{question.question}</span></div>
        <div class="answer">{answers[index]?.join(", ")}</div>
      {/each}
    </div>
  {:else}
    {@const pending = app.detail?.questions.some((request) => request.id === item.id)}
    <div class="notice">
      <MessageCircleQuestionMark size={14} />
      <span>{pending ? "Input requested" : "Question left unanswered"}</span>
    </div>
  {/if}
{:else if item.kind === "notice"}
  <div class="notice {item.level}">
    {#if item.level === "error"}<CircleAlert size={14} />{:else}<Info size={14} />{/if}
    <span>{item.text}</span>
  </div>
{/if}

<style>
  .user {
    align-self: flex-end;
    max-width: 80%;
    background: var(--surface-overlay);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-xl);
    padding: var(--space-2-5) var(--space-3);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .agent {
    background: var(--accent-soft);
    border-color: transparent;
  }
  .collapsible {
    cursor: pointer;
  }
  .collapsible:focus-visible {
    outline: 2px solid var(--focus-ring);
  }
  .collapsed .clip {
    max-height: 5lh;
    overflow: hidden;
    mask-image: linear-gradient(to bottom, #000 40%, transparent);
  }
  .assistant {
    color: var(--text-primary);
    word-break: break-word;
  }
  .assistant :global(> :first-child) {
    margin-top: 0;
  }
  .assistant :global(> :last-child) {
    margin-bottom: 0;
  }
  .assistant :global(p),
  .assistant :global(ul),
  .assistant :global(ol) {
    margin: 0 0 var(--space-3);
  }
  .assistant :global(code) {
    background: var(--surface-overlay);
    border-radius: var(--radius-sm);
    padding: 1px var(--space-1);
  }
  .assistant :global(pre) {
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    padding: var(--space-2-5) var(--space-3);
    border-radius: var(--radius-lg);
    overflow-x: auto;
  }
  .assistant :global(pre code) {
    background: none;
    padding: 0;
  }
  :global(.pr-chip) {
    white-space: nowrap;
  }
  :global(.pr-chip [data-pr-state]) {
    display: inline-flex;
    vertical-align: -2px;
    margin-right: var(--space-1);
  }
  :global([data-pr-state="unknown"]) {
    color: var(--text-muted);
  }
  .step {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  summary {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-0-5) var(--space-1-5);
    border-radius: var(--radius-sm);
    cursor: pointer;
    list-style: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:hover {
    background: var(--surface-hover);
  }
  summary.static {
    cursor: default;
  }
  summary.static:hover {
    background: none;
  }
  summary :global(svg) {
    flex-shrink: 0;
  }
  .name {
    flex-shrink: 0;
    color: var(--text-secondary);
  }
  .summary {
    color: var(--text-faint);
  }
  .running .name {
    color: var(--status-running);
  }
  .failed .name,
  .failed-label {
    color: var(--status-danger);
  }
  .failed-label {
    flex-shrink: 0;
    font-size: var(--text-2xs);
  }
  .body {
    margin: var(--space-1) 0 var(--space-2) var(--space-6);
    padding: var(--space-2) var(--space-3);
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
  }
  pre.body {
    max-height: 320px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-secondary);
  }
  .reasoning :global(p) {
    margin: 0 0 var(--space-2);
  }
  .from {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    margin-bottom: var(--space-1-5);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .handoff {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    align-self: flex-start;
    max-width: 100%;
    font-size: var(--text-sm);
    color: var(--text-primary);
  }
  .handoff-label,
  .handoff-meta {
    flex-shrink: 0;
    color: var(--text-muted);
  }
  .notice {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-muted);
    white-space: pre-wrap;
  }
  .notice :global(svg) {
    flex-shrink: 0;
    margin-top: 3px;
  }
  .asked {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .answer {
    margin-left: var(--space-6);
    color: var(--text-primary);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .notice.error {
    color: var(--status-danger);
    background: var(--status-danger-soft);
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3);
  }
</style>
