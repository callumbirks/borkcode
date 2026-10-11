<script lang="ts">
  import ArchivedView from "./components/ArchivedView.svelte";
  import FileView from "./components/FileView.svelte";
  import Home from "./components/Home.svelte";
  import ProjectView from "./components/ProjectView.svelte";
  import SettingsView from "./components/SettingsView.svelte";
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
    {:else if nav.route.view === "file"}
      {#key `${nav.route.project}/${nav.route.path}`}
        <FileView project={nav.route.project} path={nav.route.path} />
      {/key}
    {:else if nav.route.view === "settings"}
      <SettingsView />
    {:else if nav.route.view === "archived"}
      <ArchivedView />
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
  /* The main area floats as a rounded panel on the darker app background. */
  .layout {
    display: grid;
    grid-template-columns: var(--sidebar-width) 1fr;
    height: 100vh;
    background: var(--surface-app);
  }
  main {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    margin: var(--space-2) var(--space-2) var(--space-2) 0;
    background: var(--surface-base);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-xl);
    overflow: hidden;
  }
</style>
