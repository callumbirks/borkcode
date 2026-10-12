<script lang="ts" module>
  /**
   * Each project's new-thread uploads go to a draft folder on the server until the thread is
   * created with them. Pending files live in memory, so the id only needs to last as long.
   */
  const draftIds = new Map<string, string>();
</script>

<script lang="ts">
  import Folder from "@lucide/svelte/icons/folder";
  import { untrack } from "svelte";
  import type { AccessMode, Effort, ProviderKind } from "shared/protocol";
  import { uploadUrl } from "../lib/attachments";
  import { randomUuid } from "../lib/browser";
  import { referenceRoots } from "../lib/fileReferences";
  import { newThreadDraftKey } from "../lib/routes";
  import { app, go, models, rpc, showingNewThreadComposer } from "../lib/state.svelte";
  import { parseThreadDefaults, rememberThread, settingsFor, threadDefaultsKey, validChoice } from "../lib/threadDefaults";
  import Composer from "./Composer.svelte";

  let { project: name }: { project: string } = $props();

  const project = $derived(app.projects.find((candidate) => candidate.name === name));
  const draftKey = $derived(newThreadDraftKey(name));
  // The page is remounted for each project, so these are read once.
  // svelte-ignore state_referenced_locally
  const draftId = draftIds.get(name) ?? randomUuid();
  // svelte-ignore state_referenced_locally
  draftIds.set(name, draftId);

  // Starts from this device's last new thread; role and workspace always start as Thread and Worktree.
  let saved = parseThreadDefaults(localStorage.getItem(threadDefaultsKey));
  const initial = settingsFor(saved, saved.provider);
  let provider = $state<ProviderKind>(saved.provider);
  let model = $state<string | null>(initial.model);
  let effort = $state<Effort | null>(initial.effort);
  let accessMode = $state<AccessMode>(initial.accessMode);
  let fastMode = $state(initial.fastMode);
  let isolated = $state(true);
  let captain = $state(false);
  let error = $state("");

  function pickProvider(next: ProviderKind) {
    ({ model, effort, accessMode, fastMode } = settingsFor(saved, next));
  }

  // A saved model or effort the provider no longer offers quietly becomes its default once the
  // list arrives. Picks made after that come from the list, so this only runs per provider.
  $effect(() => {
    const catalog = models[provider];
    if (!catalog || catalog.error) return;
    untrack(() => ({ model, effort } = validChoice({ model, effort }, catalog.list)));
  });

  let composer = $state<Composer>();
  $effect(() => {
    if (composer) return showingNewThreadComposer(composer);
  });

  // The new thread branches from the main checkouts, so references point into them until then.
  const fileRoots = $derived(referenceRoots(project, project && `${project.path}/repos`));

  async function create(text: string, attachments: string[]) {
    const thread = await rpc.request("threads.create", {
      project: name,
      text,
      provider,
      model,
      effort,
      accessMode,
      fastMode,
      // Captains always get their own worktree.
      isolated: isolated || captain,
      captain,
      draftId,
      attachments,
    });
    saved = rememberThread(saved, provider, { model, effort, accessMode, fastMode });
    localStorage.setItem(threadDefaultsKey, JSON.stringify(saved));
    // The draft's folder is the thread's now.
    draftIds.delete(name);
    go({ view: "thread", id: thread.id });
  }
</script>

<div class="new-thread">
  <header>
    <span class="title">New thread</span>
    <a class="chip" href="#/project/{encodeURIComponent(name)}" title="Project"><Folder size={12} />{name}</a>
  </header>
  <div class="transcript">
    <div class="column">
      {#if !project}
        <p class="muted">Loading project…</p>
      {:else if project.repos.length === 0}
        <p class="muted">
          Add a repository to <a href="#/project/{encodeURIComponent(name)}">{name}</a> before starting a thread.
        </p>
      {:else}
        <p class="hint">
          What should the agent do? The thread is named from your first message, and starts once you send it.
        </p>
      {/if}
    </div>
  </div>
  <Composer
    bind:this={composer}
    {draftKey}
    uploadUrl={uploadUrl({ draftId })}
    scope={{ project: name }}
    roots={fileRoots}
    bind:error
    bind:provider
    bind:model
    bind:effort
    bind:accessMode
    bind:fastMode
    bind:captain
    bind:isolated
    newThread
    onpickprovider={pickProvider}
    onsend={create}
    requireText
    disabled={!project || project.repos.length === 0}
    sendLabel="Start thread"
    placeholder="What should the agent do?"
  />
</div>

<style>
  .new-thread {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    height: var(--header-height);
    padding: 0 var(--space-3) 0 var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
  }
  .title {
    font-weight: var(--weight-semibold);
    font-size: var(--text-sm);
    color: var(--text-primary);
    padding: var(--space-0-5) var(--space-1-5);
  }
  a.chip:hover {
    color: var(--text-primary);
    text-decoration: none;
  }
  .transcript {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-6) var(--space-6) var(--space-4);
  }
  .column {
    max-width: var(--content-width);
    margin: 0 auto;
  }
  .hint {
    color: var(--text-muted);
  }
  @media (max-width: 900px) {
    .new-thread {
      flex: 1;
    }
    header {
      padding: 0 8px;
      min-height: 44px;
    }
    .transcript {
      padding: 12px;
    }
  }
  @media (max-width: 900px), (pointer: coarse) {
    .transcript {
      min-height: 48px;
    }
    :global(html[data-short-viewport]) header {
      display: none;
    }
  }
</style>
