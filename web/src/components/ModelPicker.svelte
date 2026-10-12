<script lang="ts">
  import type { Effort, ProviderKind } from "shared/protocol";
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
  // A null model means the provider's default, so that is the one shown as selected.
  const value = $derived(model ?? list.find((option) => option.isDefault)?.id ?? "");
  const current = $derived(list.find((option) => option.id === value));

  function pickModel(id: string) {
    model = id;
    const next = list.find((option) => option.id === id);
    if (next && effort && !next.efforts.includes(effort)) effort = anyEffort ? null : next.defaultEffort;
  }
</script>

<label class:compact title={catalog?.error ?? (compact ? "Model" : undefined)}>
  {#if !compact}Model{/if}
  <select aria-label="Model" {value} onchange={(event) => pickModel(event.currentTarget.value)} disabled={!catalog}>
    {#if !catalog}
      <option value="">Loading…</option>
    {:else if !current}
      <!-- A model the provider no longer lists, or any model when listing failed. -->
      <option {value}>{value || "Default"}</option>
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
      value={effort ?? (anyEffort ? "" : current.defaultEffort) ?? ""}
      onchange={(event) => (effort = (event.currentTarget.value || null) as Effort | null)}
    >
      {#if anyEffort}<option value="">Any effort</option>
      {:else if current.defaultEffort === null}<option value="">Default</option>{/if}
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
