<script lang="ts">
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import type { Snippet } from "svelte";
  import type { AccessMode, Effort, MentionScope, ProviderKind } from "shared/protocol";
  import { composerAttachments } from "../lib/attachments";
  import {
    attachFiles,
    pendingAttachments,
    releaseAttachments,
    restoreAttachments,
    takeAttachments,
  } from "../lib/composerAttachments.svelte";
  import type { ReferenceRoots } from "../lib/fileReferences";
  import { getDraft, setDraft } from "../lib/state.svelte";
  import AttachButton from "./AttachButton.svelte";
  import ComposerAttachments from "./ComposerAttachments.svelte";
  import ComposerEditor from "./ComposerEditor.svelte";
  import ComposerOptions from "./ComposerOptions.svelte";
  import MentionPicker from "./MentionPicker.svelte";

  // The one composer, for threads and for the new-thread page: the editor, the @ picker,
  // attachments, the options row or phone sheet, and sending. Its text and files are the draft
  // under `draftKey`, so they survive navigating away and, for text, reloading.
  let {
    draftKey,
    uploadUrl,
    scope,
    roots,
    placeholder,
    error = $bindable(""),
    provider = $bindable(),
    model = $bindable(),
    effort = $bindable(),
    accessMode = $bindable(),
    fastMode = $bindable(false),
    newThread = false,
    captain = $bindable(false),
    isolated = $bindable(true),
    onpickprovider,
    onsend,
    onsubmit,
    requireText = false,
    disabled = false,
    showSend = true,
    sendLabel = "Send",
    answering = false,
    above,
    actions,
  }: {
    draftKey: string;
    uploadUrl: string;
    scope: MentionScope;
    roots: ReferenceRoots | null;
    placeholder: string;
    error?: string;
    provider: ProviderKind;
    model: string | null;
    effort: Effort | null;
    accessMode: AccessMode;
    fastMode?: boolean;
    /** Shows the agent, role and workspace pickers, which only a new thread can choose. */
    newThread?: boolean;
    captain?: boolean;
    isolated?: boolean;
    onpickprovider?: (provider: ProviderKind) => void;
    /** Sends the trimmed text and uploaded attachment ids; a throw puts both back and shows why. */
    onsend: (text: string, attachments: string[]) => Promise<void>;
    /** Takes Enter instead of sending, as answering a question does. */
    onsubmit?: () => void;
    /** A new thread is named from its first message, so files alone can't start one. */
    requireText?: boolean;
    disabled?: boolean;
    showSend?: boolean;
    sendLabel?: string;
    answering?: boolean;
    /** Banners and panels above the box, such as a pending question. */
    above?: Snippet;
    /** Buttons between the options and the send button. */
    actions?: Snippet;
  } = $props();

  const draft = $derived(getDraft(draftKey));
  const attached = $derived(composerAttachments(pendingAttachments(draftKey)));
  const hasText = $derived(draft.trim() !== "");
  const canSend = $derived(
    !disabled && (hasText || (!requireText && attached.ids.length > 0)) && attached.ready,
  );

  async function send() {
    const key = draftKey;
    const text = draft.trim();
    if (!canSend) return;
    const ids = attached.ids;
    error = "";
    setDraft(key, "");
    const pending = takeAttachments(key);
    try {
      await onsend(text, ids);
      releaseAttachments(pending);
    } catch (cause) {
      setDraft(key, text);
      restoreAttachments(key, pending);
      error = (cause as Error).message;
    }
  }

  let editor = $state<ComposerEditor>();

  /** Puts the caret after the draft, ready to type. */
  export function focus() {
    editor?.focusEnd();
  }
  let mentions = $state<MentionPicker>();

  function onKeydown(event: KeyboardEvent) {
    if (mentions?.keydown(event)) return;
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !(event.target instanceof HTMLTextAreaElement)) {
      event.preventDefault();
      if (onsubmit) onsubmit();
      else void send();
    }
  }

  // Pasted or dropped files join the message; text pasted alongside them still pastes.
  function onPaste(event: ClipboardEvent) {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    if (!event.clipboardData?.types.includes("text/plain")) event.preventDefault();
    attachFiles(draftKey, uploadUrl, files);
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
    attachFiles(draftKey, uploadUrl, files);
  }
</script>

<div class="composer-wrap">
  {#if error}<p class="error">{error}</p>{/if}
  {@render above?.()}
  <div
    class="composer"
    class:dragging
    role="group"
    ondragover={onDragOver}
    ondragleave={() => (dragging = false)}
    ondrop={onDrop}
  >
    <MentionPicker bind:this={mentions} {scope} {editor} text={draft} />
    <ComposerAttachments {draftKey} />
    <ComposerEditor
      bind:this={editor}
      value={draft}
      {roots}
      onchange={(text) => setDraft(draftKey, text)}
      onkeydown={onKeydown}
      onpaste={onPaste}
      {placeholder}
    />
    <div class="actions" class:answering>
      <span class="attachment-control"><AttachButton {draftKey} {uploadUrl} /></span>
      <ComposerOptions bind:provider bind:model bind:effort bind:accessMode bind:fastMode bind:captain bind:isolated {newThread} {onpickprovider} />
      <span class="spacer"></span>
      {@render actions?.()}
      {#if showSend}
        <button class="primary icon" aria-label={sendLabel} title="{sendLabel} (Enter)" onclick={send} disabled={!canSend}>
          <ArrowUp size={16} />
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .composer-wrap {
    padding: 0 var(--space-6) var(--space-4);
  }
  .composer-wrap > :global(*) {
    max-width: var(--content-width);
    margin-left: auto;
    margin-right: auto;
  }
  .composer-wrap > .error {
    margin-bottom: var(--space-2);
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
  .actions :global(.icon) {
    border-radius: var(--radius-full);
  }
  .attachment-control { display: contents; }

  @media (max-width: 900px) {
    .composer-wrap {
      padding: 4px 8px 8px;
    }
    .composer {
      padding: 8px;
    }
    .actions {
      flex-wrap: nowrap;
      gap: 4px;
    }
    .answering .attachment-control { display: none; }
    .actions .spacer {
      display: none;
    }
  }
  @media (max-width: 900px), (pointer: coarse) {
    /*
     * The composer takes what it needs and the transcript keeps a strip; when the text outgrows
     * that, the composer shrinks and its text box scrolls inside, so the controls row stays
     * above the keyboard. vh-based caps can't do this on iOS, where vh ignores the keyboard.
     */
    .composer-wrap {
      flex: 0 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    :global(html[data-keyboard]) .composer-wrap {
      padding-bottom: 8px;
    }
    .composer-wrap > :global(*) {
      flex-shrink: 0;
      width: 100%;
    }
    .composer {
      flex-shrink: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .composer > :global(*) {
      flex-shrink: 0;
    }
    .composer > :global(.strip) {
      flex-shrink: 1;
      min-height: 0;
      overflow-y: auto;
    }
    .composer > :global(.editor) {
      flex-shrink: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
  }
</style>
