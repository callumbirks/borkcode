<script lang="ts">
  import Home from "./components/Home.svelte";
  import ProjectView from "./components/ProjectView.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import ThreadView from "./components/ThreadView.svelte";
  import { app, nav } from "./lib/state.svelte";
</script>

<div class="layout">
  <Sidebar />
  <main>
    {#if !app.connected}
      <div class="banner">Connecting to the borkcode server…</div>
    {/if}
    {#if nav.route.view === "project"}
      {#key nav.route.name}
        <ProjectView name={nav.route.name} />
      {/key}
    {:else if nav.route.view === "thread"}
      {#key nav.route.id}
        <ThreadView id={nav.route.id} />
      {/key}
    {:else}
      <Home />
    {/if}
  </main>
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 260px 1fr;
    height: 100vh;
  }
  main {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .banner {
    padding: 6px 16px;
    background: var(--warn-bg);
    color: var(--warn);
    font-size: 13px;
  }
</style>
