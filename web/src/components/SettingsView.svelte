<script lang="ts">
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import type { AutoArchive, Effort, ModelChoice, ProviderKind } from "shared/protocol";
  import { app, models, rpc } from "../lib/state.svelte";
  import { copyText } from "../lib/browser";
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

  // The parent's model may be null while editing, meaning the picker's default, which is saved by name.
  let rules = $state<{ when: ModelChoice; use: ModelChoice }[]>([]);
  let rulesLoaded = false;
  let rulesSaved = $state(false);
  let rulesError = $state("");

  $effect(() => {
    if (!app.settings || rulesLoaded) return;
    rulesLoaded = true;
    rules = app.settings.childModelRules.map(({ when, use }) => ({ when: { ...when }, use: { ...use } }));
  });

  function setRuleProvider(choice: ModelChoice, next: ProviderKind) {
    choice.provider = next;
    choice.model = null;
    choice.effort = null;
  }

  function addRule() {
    rules.push({
      when: { provider: "claude", model: null, effort: null },
      use: { provider: "claude", model: null, effort: null },
    });
  }

  function moveRule(index: number, by: number) {
    const [rule] = rules.splice(index, 1);
    rules.splice(index + by, 0, rule!);
  }

  async function saveRules(event: SubmitEvent) {
    event.preventDefault();
    if (!app.settings) return;
    rulesError = "";
    rulesSaved = false;
    try {
      const childModelRules = rules.map(({ when, use }) => {
        const model = when.model ?? models[when.provider]?.list.find((option) => option.isDefault)?.id;
        if (!model) throw new Error("Pick the parent's model for every rule.");
        return { when: { provider: when.provider, model, effort: when.effort }, use: { ...use } };
      });
      const next = await rpc.request("settings.update", { settings: { ...app.settings, childModelRules } });
      rules = next.childModelRules.map(({ when, use }) => ({ when: { ...when }, use: { ...use } }));
      rulesSaved = true;
    } catch (cause) {
      rulesError = (cause as Error).message;
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
  let archiveDays = $state(7);
  let archiveLoaded = false;
  let archiveError = $state("");

  $effect(() => {
    if (!app.settings || archiveLoaded) return;
    archiveLoaded = true;
    archiveDays = app.settings.autoArchive.days;
  });

  async function setAutoArchive(autoArchive: AutoArchive) {
    if (!app.settings) return;
    archiveError = "";
    try {
      const next = await rpc.request("settings.update", { settings: { ...app.settings, autoArchive } });
      // Out-of-range days fall back to the default on the server; show what was kept.
      archiveDays = next.autoArchive.days;
    } catch (cause) {
      archiveError = (cause as Error).message;
    }
  }

  let networkBusy = $state(false);
  let networkError = $state("");
  let copiedUrl = $state("");
  async function setNetwork(networkAccess: boolean) {
    if (!app.settings) return;
    networkBusy = true;
    networkError = "";
    try { await rpc.request("settings.update", { settings: { ...app.settings, networkAccess } }); }
    catch (cause) { networkError = (cause as Error).message; }
    finally { networkBusy = false; }
  }
  async function copyUrl(url: string) {
    try { await copyText(url); copiedUrl = url; }
    catch (cause) { networkError = (cause as Error).message; }
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
      <section class="card network-access">
        <label class="switch">
          <input type="checkbox" role="switch" aria-label="Network access" checked={app.network?.enabled ?? app.settings.networkAccess}
            disabled={networkBusy} onchange={(event) => setNetwork(event.currentTarget.checked)} />
          <span class="track"></span>
          <span class="text">Network access<span class="muted">Use borkcode from devices on your tailnet. Local network access stays off.</span></span>
        </label>
        {#if app.network?.message}<p class="muted">{app.network.message}</p>{/if}
        {#if app.network}
          <details open={app.network.enabled}>
            <summary>Reachable at {app.network.endpoints.find((entry) => entry.label !== "This machine")?.url ?? app.network.endpoints[0]?.url}
              {#if app.network.endpoints.length > 1} +{app.network.endpoints.length - 1}{/if}
            </summary>
            {#each app.network.endpoints as endpoint (endpoint.url)}
              <div class="endpoint"><span>{endpoint.label}</span><a href={endpoint.url} target="_blank" rel="noreferrer">{endpoint.url}</a>
                <button class="ghost" onclick={() => copyUrl(endpoint.url)}>{copiedUrl === endpoint.url ? "Copied" : "Copy URL"}</button></div>
            {/each}
          </details>
        {/if}
        {#if networkError}<p class="error">{networkError}</p>{/if}
      </section>
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
      <section class="card">
        <div class="section-label">Archiving</div>
        <label class="switch">
          <input
            type="checkbox"
            role="switch"
            aria-label="Archive inactive threads"
            checked={app.settings.autoArchive.enabled}
            onchange={(event) => setAutoArchive({ enabled: event.currentTarget.checked, days: archiveDays })}
          />
          <span class="track"></span>
          <span class="text">
            Archive inactive threads automatically
            <span class="muted">
              Inactive as the sidebar's filter means it: read, idle, no open PR, and not a captain. Captains
              are only archived by hand. A thread is archived
              once nothing has happened in it and it has not been read for this many days, together
              with its child threads, which must be inactive too. Sending an archived thread a message
              brings it back.
            </span>
          </span>
        </label>
        <div class="row">
          <label>
            Days inactive
            <input
              type="number"
              min="1"
              max="365"
              step="1"
              aria-label="Days inactive"
              bind:value={archiveDays}
              onchange={() => setAutoArchive({ enabled: app.settings!.autoArchive.enabled, days: archiveDays })}
            />
          </label>
        </div>
        {#if archiveError}<p class="error">{archiveError}</p>{/if}
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
      <form class="card" onsubmit={saveRules}>
        <div class="section-label">Child thread models</div>
        <p class="muted hint">
          Threads that start threads pick their children's model by the first rule that matches their
          own. Without a match, children copy their parent. An agent that names a model, effort or
          agent for a child overrides the rule.
        </p>
        {#each rules as rule, index}
          <div class="rule">
            <div class="row">
              <span class="step">When the parent is</span>
              <label>
                Agent
                <select
                  value={rule.when.provider}
                  onchange={(event) => setRuleProvider(rule.when, event.currentTarget.value as ProviderKind)}
                >
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                </select>
              </label>
              <ModelPicker provider={rule.when.provider} bind:model={rule.when.model} bind:effort={rule.when.effort} anyEffort />
              <span class="grow"></span>
              <button type="button" class="ghost icon" title="Move up" disabled={index === 0} onclick={() => moveRule(index, -1)}>
                <ArrowUp size={16} />
              </button>
              <button
                type="button"
                class="ghost icon"
                title="Move down"
                disabled={index === rules.length - 1}
                onclick={() => moveRule(index, 1)}
              >
                <ArrowDown size={16} />
              </button>
              <button type="button" class="ghost icon" title="Remove rule" onclick={() => rules.splice(index, 1)}>
                <Trash2 size={16} />
              </button>
            </div>
            <div class="row">
              <span class="step">children use</span>
              <label>
                Agent
                <select
                  value={rule.use.provider}
                  onchange={(event) => setRuleProvider(rule.use, event.currentTarget.value as ProviderKind)}
                >
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                </select>
              </label>
              <ModelPicker provider={rule.use.provider} bind:model={rule.use.model} bind:effort={rule.use.effort} />
            </div>
          </div>
        {:else}
          <p class="muted hint">No rules: children copy their parent's model.</p>
        {/each}
        <div class="row">
          <button type="button" onclick={addRule}>Add rule</button>
          <button class="primary" type="submit">Save</button>
          {#if rulesSaved}<span class="muted">Saved</span>{/if}
        </div>
        {#if rulesError}<p class="error">{rulesError}</p>{/if}
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
  .rule {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border-subtle);
  }
  .step {
    width: 120px;
    padding-bottom: var(--space-1-5);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .endpoint { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 0; }
  .endpoint a { overflow-wrap: anywhere; flex: 1; min-width: 150px; }
  .network-access summary { overflow-wrap: anywhere; }
</style>
