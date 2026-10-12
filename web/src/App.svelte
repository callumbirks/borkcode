<script lang="ts">
  import Menu from "@lucide/svelte/icons/menu";
  import X from "@lucide/svelte/icons/x";
  import ArchivedView from "./components/ArchivedView.svelte";
  import FileView from "./components/FileView.svelte";
  import Home from "./components/Home.svelte";
  import ProjectView from "./components/ProjectView.svelte";
  import SettingsView from "./components/SettingsView.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import ThreadView from "./components/ThreadView.svelte";
  import { app, nav } from "./lib/state.svelte";
  import { viewportTracker } from "./lib/viewport";

  let drawer = $state(false);
  let compact = $state(window.innerWidth <= 900);
  $effect(() => {
    const media = matchMedia("(max-width: 900px)");
    const update = () => compact = media.matches;
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  });
  $effect(() => { void nav.route; drawer = false; });
  // Everything on a phone is sized to the visible viewport, since iOS keeps the keyboard's
  // height in 100dvh and window.innerHeight.
  $effect(() => {
    const viewport = window.visualViewport;
    const track = viewportTracker();
    const root = document.documentElement;
    const update = () => {
      const layout = track({
        height: viewport?.height ?? window.innerHeight,
        top: viewport?.offsetTop ?? 0,
        scale: viewport?.scale ?? 1,
        layoutWidth: root.clientWidth,
        layoutHeight: root.clientHeight,
      });
      root.style.setProperty("--viewport-height", `${layout.height}px`);
      root.style.setProperty("--viewport-top", `${layout.top}px`);
      root.style.setProperty("--viewport-bottom", `${layout.bottom}px`);
      root.toggleAttribute("data-keyboard", layout.keyboard);
    };
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  });
  let chipPath = $state("");
  function showChipPath(event: PointerEvent) {
    if (event.pointerType === "mouse") return;
    chipPath = (event.target as HTMLElement).closest<HTMLElement>(".file-chip")?.title ?? "";
  }
</script>

<svelte:window onkeydown={(event) => { if (event.key === "Escape") drawer = false; }} onpointerdown={showChipPath} />
<div class="layout">
  {#if drawer}<button class="backdrop" aria-label="Close navigation" onclick={() => drawer = false}></button>{/if}
  <div class="sidebar" class:open={drawer} inert={compact && !drawer}>
    <button class="drawer-close ghost icon" aria-label="Close navigation" onclick={() => drawer = false}><X size={20} /></button>
    <Sidebar />
  </div>
  <main inert={compact && drawer}>
    <div class="mobile-bar">
      <button class="ghost icon" aria-label="Open navigation" aria-expanded={drawer} onclick={() => drawer = !drawer}><Menu size={20} /></button>
      <span>borkcode</span>
    </div>
    {#if chipPath}<div class="chip-path" role="status">{chipPath}<button class="ghost icon" aria-label="Close file path" onclick={() => chipPath = ""}><X size={16} /></button></div>{/if}
    {#if !app.connected}
      <div class="banner">Connecting to the borkcode server…</div>
    {/if}
    {#if nav.route.view === "project"}
      {#key nav.route.name}
        <ProjectView name={nav.route.name} {compact} />
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
        <ThreadView id={nav.route.id} {compact} />
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
    height: 100dvh;
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

  .sidebar {
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .sidebar :global(nav) {
    flex: 1;
    min-height: 0;
  }
  .mobile-bar, .drawer-close {
    display: none;
  }
  .chip-path {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px;
    overflow-wrap: anywhere;
    font-size: var(--text-xs);
  }
  @media (max-width: 900px) {
    .layout {
      position: fixed;
      top: var(--viewport-top, 0px);
      width: 100%;
      height: var(--viewport-height, 100dvh);
      grid-template-columns: minmax(0, 1fr);
      padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
    }
    /* The keyboard covers the home indicator, so its inset would only leave a gap above the keys. */
    :global(html[data-keyboard]) .layout {
      padding-bottom: 0;
    }
    main {
      margin: 0;
      border: 0;
      border-radius: 0;
    }
    .mobile-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
      border-bottom: 1px solid var(--border-subtle);
    }
    .sidebar {
      position: absolute;
      inset: 0 auto 0 0;
      width: min(320px, 88vw);
      background: var(--surface-app);
      z-index: 30;
      transform: translateX(-100%);
      visibility: hidden;
      padding-top: env(safe-area-inset-top);
    }
    .sidebar.open {
      transform: none;
      visibility: visible;
    }
    .drawer-close {
      display: flex;
      align-self: flex-end;
      margin: 4px;
    }
    .backdrop {
      position: absolute;
      inset: 0;
      z-index: 29;
      border: 0;
      border-radius: 0;
      background: #0009;
    }
  }
</style>
