<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Crown from "@lucide/svelte/icons/crown";
  import FolderGit2 from "@lucide/svelte/icons/folder-git-2";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import Shield from "@lucide/svelte/icons/shield";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import Zap from "@lucide/svelte/icons/zap";
  import type { AccessMode, Effort, ProviderKind } from "shared/protocol";
  import { findModel } from "shared/models";
  import { models } from "../lib/state.svelte";
  import ModelPicker from "./ModelPicker.svelte";

  let {
    provider = $bindable(), model = $bindable(), effort = $bindable(), accessMode = $bindable(), fastMode = $bindable(false),
    newThread = false, captain = $bindable(false), isolated = $bindable(true), onpickprovider,
  }: {
    provider: ProviderKind; model: string | null; effort: Effort | null; accessMode: AccessMode; fastMode?: boolean;
    newThread?: boolean; captain?: boolean; isolated?: boolean;
    /** Sets the new provider's model, effort, access and fast mode; without it they reset to its defaults. */
    onpickprovider?: (provider: ProviderKind) => void;
  } = $props();
  let dialog: HTMLDialogElement;
  const current = $derived(findModel(models[provider]?.list ?? [], model));
  const name = $derived(current?.name.replace(/\s*\(.*\)$/, "") || model || (provider === "claude" ? "Claude" : "Codex"));
  const level = $derived(effort ?? current?.defaultEffort);
  const summary = $derived((newThread ? `${provider === "claude" ? "Claude" : "Codex"} · ` : "") + name +
    (level ? ` · ${level === "medium" ? "Med" : level}` : ""));

  function pickProvider(next: ProviderKind) {
    provider = next;
    if (onpickprovider) onpickprovider(next);
    else {
      model = null;
      effort = null;
      fastMode = false;
    }
  }
  function dismissBackdrop(event: MouseEvent) {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  }
</script>

{#snippet providerPicker()}
  <label>Agent
    <select aria-label="Agent" value={provider} onchange={(event) => pickProvider(event.currentTarget.value as ProviderKind)}>
      <option value="claude">Claude</option><option value="codex">Codex</option>
    </select>
  </label>
{/snippet}
{#snippet accessPicker()}
  <label>Access
    <select aria-label="Access" bind:value={accessMode}>
      <option value="ask">Ask first</option><option value="full">Full access</option>
    </select>
  </label>
{/snippet}
{#snippet fastPicker()}
  {#if current?.supportsFastMode}
    <label>Fast mode
      <select aria-label="Fast mode" bind:value={fastMode}><option value={false}>Off</option><option value={true}>On: faster output, higher price</option></select>
    </label>
  {/if}
{/snippet}
<!--
  Two-way choices as icon toggles, each naming its current state. Pressed is the less usual
  choice. Fast mode shows only for models that offer it; the choice is kept for one that does.
  On a phone the row has room for fast mode and access only; the rest are in the sheet.
-->
{#snippet toggles(phone: boolean)}
  {#if current?.supportsFastMode}
    {@const label = `Fast mode: ${fastMode ? "on" : "off"}`}
    <button type="button" class="ghost icon toggle" class:on={fastMode} aria-pressed={fastMode} aria-label={label}
      title="{label}. Same model, faster output, higher price" onclick={() => (fastMode = !fastMode)}>
      <Zap size={16} fill={fastMode ? "currentColor" : "none"} />
    </button>
  {/if}
  {@const full = accessMode === "full"}
  <button type="button" class="ghost icon toggle" class:warn={full} aria-pressed={full}
    aria-label="Access: {full ? 'full access' : 'ask first'}"
    title="Access: {full ? 'full access, the agent acts without asking' : 'ask first, risky actions wait for you'}"
    onclick={() => (accessMode = full ? "ask" : "full")}>
    {#if full}<ShieldAlert size={16} />{:else}<Shield size={16} />{/if}
  </button>
  {#if newThread && !phone}
    <button type="button" class="ghost icon toggle" class:on={captain} aria-pressed={captain}
      aria-label="Role: {captain ? 'captain' : 'thread'}"
      title="Role: {captain ? 'captain, coordinates the threads it starts' : 'thread'}"
      onclick={() => (captain = !captain)}>
      <Crown size={16} />
    </button>
    {@const main = !isolated && !captain}
    <button type="button" class="ghost icon toggle" class:on={main} aria-pressed={main} disabled={captain}
      aria-label="Workspace: {main ? 'main checkouts' : 'new worktree'}"
      title={captain ? "Workspace: new worktree, as captains always get one" : `Workspace: ${main ? "main checkouts in repos/" : "new worktree on its own branch"}`}
      onclick={() => (isolated = !isolated)}>
      {#if main}<FolderGit2 size={16} />{:else}<GitBranch size={16} />{/if}
    </button>
  {/if}
{/snippet}
{#snippet threadOptions()}
  <label>Role
    <select aria-label="Role" bind:value={captain}><option value={false}>Thread</option><option value={true}>Captain</option></select>
  </label>
  <label>Workspace
    <select aria-label="Workspace" bind:value={isolated} disabled={captain}><option value={true}>New worktrees</option><option value={false}>Main checkouts</option></select>
  </label>
{/snippet}

<div class="desktop-options">
  {#if newThread}{@render providerPicker()}{/if}
  <ModelPicker {provider} bind:model bind:effort compact />
  {@render toggles(false)}
</div>
<div class="phone-options">
  <button type="button" class="ghost summary" aria-label={`Composer options: ${newThread ? `${provider === "claude" ? "Claude" : "Codex"}, ` : ""}${name}${level ? `, ${level} effort` : ""}${newThread ? `, ${captain ? "captain" : "thread"}, ${isolated || captain ? "new worktree" : "main checkouts"}` : ""}`} aria-haspopup="dialog" onclick={() => dialog.showModal()}>
    <span>{summary}</span><ChevronDown size={14} />
  </button>
  {@render toggles(true)}
</div>
<!-- A top-layer dialog escapes compositor transforms and transcript containment. -->
<dialog bind:this={dialog} aria-label="Composer options" onclick={dismissBackdrop}>
  <div class="sheet-header"><strong>Composer options</strong><button type="button" onclick={() => dialog.close()}>Done</button></div>
  <div class="fields">
    {#if newThread}{@render providerPicker()}{/if}
    <ModelPicker {provider} bind:model bind:effort />
    {@render fastPicker()}
    {@render accessPicker()}
    {#if newThread}{@render threadOptions()}{/if}
  </div>
</dialog>

<style>
  .desktop-options { display: contents; }
  .desktop-options :global(label) { font-size: 0; }
  .desktop-options :global(select) {
    font-size: var(--text-sm); background: none; border-color: transparent;
    color: var(--text-secondary); padding: var(--space-1) var(--space-1-5);
  }
  .desktop-options :global(select:hover:not(:disabled)) { background: var(--surface-hover); color: var(--text-primary); }
  .toggle.on { color: var(--text-primary); background: var(--surface-active); }
  .toggle.warn { color: var(--status-warning); }
  .phone-options { display: none; }
  dialog {
    color: var(--text-primary); background: var(--surface-raised); border: 1px solid var(--border-default);
    border-radius: var(--radius-xl); width: 420px; max-width: calc(100% - 24px); padding: 16px;
  }
  dialog::backdrop { background: #0008; }
  .sheet-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
  .sheet-header button { min-height: 44px; }
  .fields { display: flex; flex-direction: column; gap: 12px; }
  .fields :global(label) { display: flex; flex-direction: column; gap: 6px; }
  .fields :global(select) { width: 100%; min-height: 44px; font-size: 16px; }
  @media (max-width: 900px) {
    .desktop-options { display: none; }
    .phone-options { display: flex; flex: 1; min-width: 0; gap: 4px; }
    .phone-options .toggle { flex-shrink: 0; }
    .summary { flex: 1; min-width: 0; min-height: 40px; padding: 4px 8px; gap: 6px; }
    .summary span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .summary :global(svg) { flex-shrink: 0; }
    dialog {
      position: fixed; inset: auto 0 var(--viewport-bottom, 0px); margin: 0; width: 100%; max-width: none;
      max-height: calc(var(--viewport-height, 100dvh) - 24px); overflow: auto;
      padding: 16px 16px calc(16px + env(safe-area-inset-bottom));
      border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    }
    :global(html[data-keyboard]) dialog { padding-bottom: 16px; }
  }
</style>
