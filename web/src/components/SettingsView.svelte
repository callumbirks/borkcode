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

  let limits = $state({ wakesPerWindow: 8, windowMinutes: 10, maxAutomaticTurns: 50 });
  let limitsLoaded = false;
  let limitsSaved = $state(false);
  let limitsError = $state("");

  $effect(() => {
    if (!app.settings || limitsLoaded) return;
    limitsLoaded = true;
    limits = { ...app.settings.delegation };
  });

  async function saveLimits(event: SubmitEvent) {
    event.preventDefault();
    if (!app.settings) return;
    limitsError = "";
    limitsSaved = false;
    try {
      const next = await rpc.request("settings.update", { settings: { ...app.settings, delegation: limits } });
      // Out-of-range values fall back to defaults on the server; show what was kept.
      limits = { ...next.delegation };
      limitsSaved = true;
    } catch (cause) {
      limitsError = (cause as Error).message;
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
  <div class="page-inner">
    <div class="page-header">
      <h1>Settings</h1>
      <p class="muted">Stored in settings.json in the borkcode home, which is safe to hand-edit.</p>
    </div>
    {#if app.settingsError}
      <p class="error">{app.settingsError}</p>
    {:else if !app.settings}
      <p class="muted">Loading settings…</p>
    {:else}
      <section class="card">
        <div class="section-label">Worktree threads</div>
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
      <form class="card" onsubmit={saveLimits}>
        <div class="section-label">Delegation limits</div>
        <p class="muted hint">
          Threads that watch each other wake each other up. When they do so too often, deliveries
          between them pause until you resume them or message one of them.
        </p>
        <div class="row">
          <label>
            Wake-ups per thread
            <input type="number" min="1" step="1" bind:value={limits.wakesPerWindow} />
          </label>
          <label>
            Within minutes
            <input type="number" min="1" step="1" bind:value={limits.windowMinutes} />
          </label>
          <label>
            Automatic turns per captain, since you last spoke
            <input type="number" min="1" step="1" bind:value={limits.maxAutomaticTurns} />
          </label>
          <button class="primary" type="submit">Save</button>
          {#if limitsSaved}<span class="muted">Saved</span>{/if}
        </div>
        {#if limitsError}<p class="error">{limitsError}</p>{/if}
      </form>
      <form class="card" onsubmit={save}>
        <div class="section-label">Thread titles</div>
        <p class="muted hint">New threads are named from their first message by this model.</p>
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
</div>

<style>
  .switch {
    flex-direction: row;
    align-items: flex-start;
    gap: 12px;
    cursor: pointer;
    font-size: var(--text-sm);
    color: var(--text-primary);
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
    border-radius: var(--radius-full);
    background: var(--border-strong);
    transition: background var(--transition-fast);
  }
  .track::after {
    content: "";
    position: absolute;
    top: 3px;
    left: 3px;
    width: 14px;
    height: 14px;
    border-radius: var(--radius-full);
    background: var(--text-primary);
    transition: left var(--transition-fast);
  }
  .switch input:checked + .track {
    background: var(--accent);
  }
  .switch input:checked + .track::after {
    left: 17px;
    background: var(--text-on-accent);
  }
  .switch input:focus-visible + .track {
    outline: 2px solid var(--focus-ring);
    outline-offset: 2px;
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .text .muted,
  .hint {
    font-size: var(--text-xs);
  }
</style>
