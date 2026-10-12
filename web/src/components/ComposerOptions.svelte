<script lang="ts">
  import Shield from "@lucide/svelte/icons/shield";
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import type { AccessMode, Effort, ProviderKind } from "shared/protocol";
  import { models } from "../lib/state.svelte";
  import ModelPicker from "./ModelPicker.svelte";

  let {
    provider = $bindable(), model = $bindable(), effort = $bindable(), accessMode = $bindable(),
    newThread = false, captain = $bindable(false), isolated = $bindable(true), onpickprovider,
  }: {
    provider: ProviderKind; model: string | null; effort: Effort | null; accessMode: AccessMode;
    newThread?: boolean; captain?: boolean; isolated?: boolean;
    /** Sets the new provider's model, effort and access; without it they reset to its defaults. */
    onpickprovider?: (provider: ProviderKind) => void;
  } = $props();
  let dialog: HTMLDialogElement;
  const current = $derived(models[provider]?.list.find((item) => model ? item.id === model : item.isDefault));
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
  {@render accessPicker()}
  {#if newThread}{@render threadOptions()}{/if}
</div>
<div class="phone-options">
  <button type="button" class="ghost summary" aria-label={`Model and access: ${name}, ${level ?? "default effort"}, ${accessMode === "full" ? "full access" : "ask first"}`} aria-haspopup="dialog" onclick={() => dialog.showModal()}>
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
