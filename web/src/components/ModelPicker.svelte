<script lang="ts">
  import type { Effort, ProviderKind } from "shared/protocol";
  import { findModel, resolveDefaults } from "shared/models";
  import { loadModels, models } from "../lib/state.svelte";

  let {
    provider,
    model = $bindable(),
    effort = $bindable(),
    compact = false,
    anyEffort = false,
  }: {
    provider: ProviderKind;
    model: string | null;
    effort: Effort | null;
    /** Borderless selects without labels, for toolbars such as the composer's. */
    compact?: boolean;
    /** A null effort means any effort rather than the default, for matching. */
    anyEffort?: boolean;
  } = $props();

  $effect(() => {
    void loadModels(provider);
  });

  const catalog = $derived(models[provider]);
  const list = $derived(catalog?.list ?? []);
  const current = $derived(list.length > 0 ? findModel(list, model) : undefined);
  const value = $derived(current?.id ?? model ?? "");

  // The picker always holds a concrete model and effort: a saved null (the provider's default),
  // Claude's old "default", or an effort the model lacks is replaced by its name once the list
  // arrives, so that is what is shown, sent and saved next.
  $effect(() => {
    if (!current) return;
    if (model !== current.id) model = current.id;
    const level = anyEffort
      ? effort !== null && current.efforts.includes(effort) ? effort : null
      : resolveDefaults({ model, effort }, list).effort;
    if (effort !== level) effort = level;
  });
</script>

<label class:compact title={catalog?.error ?? (compact ? "Model" : undefined)}>
  {#if !compact}Model{/if}
  <select aria-label="Model" {value} onchange={(event) => (model = event.currentTarget.value)} disabled={!catalog}>
    {#if !catalog}
      <option value="">Loading…</option>
    {:else if !current}
      <!-- A model the provider no longer lists, or any model when listing failed. -->
      <option {value}>{value || "Unknown model"}</option>
    {/if}
    {#each list as option (option.id)}
      <option value={option.id}>{option.name}</option>
    {/each}
  </select>
</label>
{#if current && current.efforts.length > 0}
  <label class:compact title={compact ? "Effort" : undefined}>
    {#if !compact}Effort{/if}
    <select
      class="effort"
      aria-label="Effort"
      value={effort ?? ""}
      onchange={(event) => (effort = (event.currentTarget.value || null) as Effort | null)}
    >
      {#if anyEffort}<option value="">Any effort</option>{/if}
      {#each current.efforts as level (level)}
        <option value={level}>{level}</option>
      {/each}
    </select>
  </label>
{/if}
{#if catalog?.error}<span class="error" title={catalog.error}>Could not list models</span>{/if}

<style>
  .compact select {
    background: none;
    border-color: transparent;
    color: var(--text-secondary);
    padding: var(--space-1) var(--space-1-5);
  }
  .compact .effort {
    text-transform: capitalize;
  }
  .compact select:hover:not(:disabled) {
    background: var(--surface-hover);
    color: var(--text-primary);
  }
  .compact select:focus {
    border-color: transparent;
  }
</style>
