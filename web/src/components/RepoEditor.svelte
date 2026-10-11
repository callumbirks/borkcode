<script lang="ts">
  import FolderGit2 from "@lucide/svelte/icons/folder-git-2";
  import Pencil from "@lucide/svelte/icons/pencil";
  import type { RepoConfig } from "shared/protocol";
  import { rpc } from "../lib/state.svelte";

  let { project, repo }: { project: string; repo: RepoConfig } = $props();

  let editing = $state(false);
  let baseBranch = $state("");
  let setup = $state("");
  let error = $state("");

  function startEditing() {
    baseBranch = repo.baseBranch;
    setup = repo.setup ?? "";
    error = "";
    editing = true;
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    try {
      await rpc.request("repos.update", { project, name: repo.name, baseBranch, setup });
      editing = false;
    } catch (cause) {
      error = (cause as Error).message;
    }
  }
</script>

<div class="repo">
  <div class="summary">
    <FolderGit2 size={16} class="muted" />
    <div class="lines">
      <span class="name">{repo.name}</span>
      <span class="url truncate">{repo.url}</span>
    </div>
    <span class="chip">base {repo.baseBranch}</span>
    {#if repo.setup}<span class="chip" title={repo.setup}>setup</span>{/if}
    <button class="ghost icon" title={editing ? "Cancel" : "Edit"} onclick={() => (editing ? (editing = false) : startEditing())}>
      <Pencil size={14} />
    </button>
  </div>
  {#if editing}
    <form class="row" onsubmit={save}>
      <label>
        Base branch
        <input bind:value={baseBranch} size="12" />
      </label>
      <label class="grow">
        Setup command (runs in each new worktree)
        <input bind:value={setup} placeholder={'cp "$BORKCODE_MAIN_REPO/.env" . && pnpm install'} />
      </label>
      <button type="button" class="ghost" onclick={() => (editing = false)}>Cancel</button>
      <button class="primary" type="submit">Save</button>
    </form>
    {#if error}<p class="error">{error}</p>{/if}
  {/if}
</div>

<style>
  .repo {
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border-subtle);
  }
  .summary {
    display: flex;
    gap: var(--space-3);
    align-items: center;
  }
  .lines {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .name {
    font-weight: var(--weight-medium);
  }
  .url {
    font-size: var(--text-xs);
    color: var(--text-faint);
  }
  form {
    margin: var(--space-3) 0 var(--space-1) var(--space-8);
  }
  .grow {
    min-width: 260px;
  }
</style>
