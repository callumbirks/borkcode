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
    if (!app.settings) return;
    error = "";
    saved = false;
    try {
      await rpc.request("settings.update", {
        settings: { ...app.settings, titleModel: { provider, model, effort } },
      });
      saved = true;
    } catch (cause) {
      error = (cause as Error).message;
    }
  }

  let toggleError = $state("");

  async function setAutoCommit(autoCommit: boolean) {
    if (!app.settings) return;
    toggleError = "";
    try {
      await rpc.request("settings.update", { settings: { ...app.settings, autoCommit } });
    } catch (cause) {
      toggleError = (cause as Error).message;
    }
  }
</script>

<div class="page">
  <h1>Settings</h1>
  {#if app.settingsError}
    <p class="error">{app.settingsError}</p>
  {:else if !app.settings}
    <p class="muted">Loading settings…</p>
  {:else}
    <section class="card">
      <h2>Worktree threads</h2>
      <label class="switch">
        <input
          type="checkbox"
          role="switch"
          checked={app.settings.autoCommit}
          onchange={(event) => setAutoCommit(event.currentTarget.checked)}
        />
        <span class="track"></span>
        <span class="text">
          Auto-commit changes in worktree threads
          <span class="muted">
            Agents commit each finished step on the thread's branch without being asked. Threads in
            the main checkouts only commit when asked. Applies to agent sessions started after the change.
          </span>
        </span>
      </label>
      {#if toggleError}<p class="error">{toggleError}</p>{/if}
    </section>
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

<style>
  .switch {
    flex-direction: row;
    align-items: flex-start;
    gap: 12px;
    cursor: pointer;
    font-size: 14px;
    color: var(--text);
  }
  .switch input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .track {
    position: relative;
    flex-shrink: 0;
    width: 34px;
    height: 20px;
    margin-top: 1px;
    border-radius: 10px;
    background: var(--border);
  }
  .track::after {
    content: "";
    position: absolute;
    top: 3px;
    left: 3px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--text);
  }
  .switch input:checked + .track {
    background: var(--accent);
  }
  .switch input:checked + .track::after {
    left: 17px;
    background: var(--accent-text);
  }
  .switch input:focus-visible + .track {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .text .muted {
    font-size: 12px;
  }
</style>
