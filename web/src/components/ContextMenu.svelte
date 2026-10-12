<script lang="ts" module>
  export type MenuItem = { label: string; run: () => void };
</script>

<script lang="ts">
  let { x, y, items, onclose }: { x: number; y: number; items: MenuItem[]; onclose: () => void } = $props();

  // Focus goes back to whatever opened the menu, such as a sidebar row opened by keyboard.
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let menu: HTMLDivElement | undefined = $state();
  let position = $state({ left: 0, top: 0 });

  function close() {
    onclose();
    opener?.focus({ preventScroll: true });
  }

  function choose(item: MenuItem) {
    close();
    item.run();
  }

  function onKeydown(event: KeyboardEvent) {
    const buttons = [...(menu?.querySelectorAll("button") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const focus = (next: number) => buttons[(next + buttons.length) % buttons.length]?.focus();
    if (event.key === "Escape" || event.key === "Tab") close();
    else if (event.key === "ArrowDown") focus(index + 1);
    else if (event.key === "ArrowUp") focus(index - 1);
    else if (event.key === "Home") focus(0);
    else if (event.key === "End") focus(-1);
    else return;
    event.preventDefault();
  }

  /**
   * The sidebar is its own compositor layer, which would become the containing block of a fixed
   * menu, so the menu lives in the body. It stays inside the viewport.
   */
  function place(node: HTMLDivElement) {
    document.body.append(node);
    const { width, height } = node.getBoundingClientRect();
    position = {
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
    };
    node.querySelector("button")?.focus();
    const outside = (event: Event) => {
      if (!node.contains(event.target as Node)) onclose();
    };
    // Capture, so a press elsewhere closes the menu before it does anything else.
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", onclose, true);
    window.addEventListener("resize", onclose);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", onclose, true);
      window.removeEventListener("resize", onclose);
      node.remove();
    };
  }
</script>

<div
  class="menu"
  role="menu"
  tabindex="-1"
  style:left="{position.left}px"
  style:top="{position.top}px"
  bind:this={menu}
  onkeydown={onKeydown}
  oncontextmenu={(event) => event.preventDefault()}
  {@attach place}
>
  {#each items as item (item.label)}
    <button class="ghost" role="menuitem" tabindex="-1" onclick={() => choose(item)}>{item.label}</button>
  {/each}
</div>

<style>
  .menu {
    position: fixed;
    z-index: 50;
    display: flex;
    flex-direction: column;
    min-width: 160px;
    padding: var(--space-1);
    background: var(--surface-overlay);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
  }
  button {
    justify-content: flex-start;
    font-weight: var(--weight-regular);
    color: var(--text-primary);
  }
  @media (pointer: coarse) {
    button {
      min-height: 44px;
    }
  }
</style>
