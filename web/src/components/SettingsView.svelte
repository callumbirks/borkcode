<script lang="ts">
  import type { Effort, ProviderKind } from "shared/protocol";
  import { app, rpc } from "../lib/state.svelte";
  import ModelPicker from "./ModelPicker.svelte";

  let provider = $state<ProviderKind>("codex");
  let model = $state<string | null>(null);
  let effort = $state<Effort | null>(null);
  let loaded = false;
  let saved = $state(false);
  let error = $state("");

  $effect(() => {
    if (!app.settings || loaded) return;
    loaded = true;
    ({ provider, model, effort } = app.settings.titleModel);
  });

  function pickProvider(next: ProviderKind) {
    provider = next;
    model = null;
    effort = null;
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    error = "";
    saved = false;
    try {
      await rpc.request("settings.update", { settings: { titleModel: { provider, model, effort } } });
      saved = true;
    } catch (cause) {
      error = (cause as Error).message;
    }
  }
</script>

<div class="page">
  <h1>Settings</h1>
  {#if !app.settings}
    <p class="muted">Loading settings…</p>
  {:else}
    <form class="card" onsubmit={save}>
      <h2>Thread titles</h2>
      <p class="muted">New threads are named from their first message by this model.</p>
      <div class="row">
        <label>
          Agent
          <select value={provider} onchange={(event) => pickProvider(event.currentTarget.value as ProviderKind)}>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
        </label>
        <ModelPicker {provider} bind:model bind:effort />
        <button class="primary" type="submit">Save</button>
        {#if saved}<span class="muted">Saved</span>{/if}
      </div>
      {#if error}<p class="error">{error}</p>{/if}
    </form>
  {/if}
</div>
