<script lang="ts">
  import Shield from "@lucide/svelte/icons/shield";
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
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
<!-- Shown only for models that offer it; the choice is kept, and asked for again on one that does. -->
{#snippet fastToggle()}
  {#if current?.supportsFastMode}
    <button type="button" class="ghost icon toggle" class:on={fastMode} aria-pressed={fastMode}
      aria-label={`Fast mode: ${fastMode ? "on" : "off"}`} title={`Fast mode: ${fastMode ? "on" : "off"} (same model, faster output, higher price)`}
      onclick={() => (fastMode = !fastMode)}>
      <Zap size={16} fill={fastMode ? "currentColor" : "none"} />
    </button>
  {/if}
{/snippet}
{#snippet fastPicker()}
  {#if current?.supportsFastMode}
    <label>Fast mode
      <select aria-label="Fast mode" bind:value={fastMode}><option value={false}>Off</option><option value={true}>On: faster output, higher price</option></select>
    </label>
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
  {@render fastToggle()}
  {@render accessPicker()}
  {#if newThread}{@render threadOptions()}{/if}
</div>
<div class="phone-options">
  <button type="button" class="ghost summary" aria-label={`Model and access: ${name}, ${level ? `${level} effort, ` : ""}${accessMode === "full" ? "full access" : "ask first"}`} aria-haspopup="dialog" onclick={() => dialog.showModal()}>
    {#if accessMode === "full"}<ShieldCheck size={16} />{:else}<Shield size={16} />{/if}
    <span>{summary}</span><ChevronDown size={14} />
  </button>
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
  .toggle { color: var(--text-secondary); }
  .toggle.on { color: var(--text-primary); }
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
    .phone-options { display: flex; flex: 1; min-width: 0; }
    .summary { width: 100%; min-width: 0; min-height: 40px; padding: 4px 8px; gap: 6px; }
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
