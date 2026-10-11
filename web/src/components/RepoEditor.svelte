<script lang="ts">
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
    <strong>{repo.name}/</strong>
    <span class="muted">{repo.url}</span>
    <span class="muted">base {repo.baseBranch}</span>
    {#if repo.setup}<code class="muted">setup: {repo.setup}</code>{/if}
    <button onclick={() => (editing ? (editing = false) : startEditing())}>{editing ? "Cancel" : "Edit"}</button>
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
      <button class="primary" type="submit">Save</button>
    </form>
    {#if error}<p class="error">{error}</p>{/if}
  {/if}
</div>

<style>
  .repo {
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .summary {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
  }
  .summary button {
    margin-left: auto;
  }
  form {
    margin-top: 8px;
  }
  .grow {
    flex: 1;
    min-width: 260px;
  }
</style>
