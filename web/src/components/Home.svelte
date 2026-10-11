<script lang="ts">
  import { app, go, rpc } from "../lib/state.svelte";

  let name = $state("");
  let error = $state("");

  async function create(event: SubmitEvent) {
    event.preventDefault();
    error = "";
    try {
      const project = await rpc.request("projects.create", { name });
      name = "";
      go({ view: "project", name: project.name });
    } catch (cause) {
      error = (cause as Error).message;
    }
  }
</script>

<div class="page">
  <h1>Projects</h1>
  <p class="muted">
    A project groups the repositories you work on together. Every thread gets its own workspace
    with a checkout of each repository, side by side.
  </p>
  <form class="card row" onsubmit={create}>
    <label>
      New project
      <input bind:value={name} placeholder="doofcraft" required />
    </label>
    <button class="primary" type="submit">Create</button>
    {#if error}<span class="error">{error}</span>{/if}
  </form>
  {#each app.projects as project (project.name)}
    <button class="card project" onclick={() => go({ view: "project", name: project.name })}>
      <strong>{project.name}</strong>
      <span class="muted">{project.repos.map((repo) => repo.name).join(", ") || "No repositories yet"}</span>
    </button>
  {/each}
</div>

<style>
  .project {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    width: 100%;
    text-align: left;
    gap: 4px;
  }
</style>
