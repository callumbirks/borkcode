<script lang="ts" module>
  import type Icon from "@lucide/svelte/icons/circle";

  /**
   * `danger` items, such as Delete, come last after a separator. A disabled item shows why
   * beneath its label, since touch has no tooltips.
   */
  export type MenuItem = { label: string; icon: typeof Icon; run: () => void; danger?: boolean; disabled?: string };
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
    const buttons = [...(menu?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
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
    node.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
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
  {#each items as item, index (item.label)}
    {#if item.danger && index > 0 && !items[index - 1]?.danger}<div class="separator" role="separator"></div>{/if}
    <button
      class="ghost"
      class:danger={item.danger}
      role="menuitem"
      tabindex="-1"
      disabled={!!item.disabled}
      title={item.disabled}
      onclick={() => choose(item)}
    >
      <item.icon size={14} />
      <span class="text">
        {item.label}
        {#if item.disabled}<span class="hint truncate">{item.disabled}</span>{/if}
      </span>
    </button>
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
    gap: var(--space-2);
    font-weight: var(--weight-regular);
    color: var(--text-primary);
  }
  button :global(svg) {
    flex-shrink: 0;
    color: var(--text-muted);
  }
  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    text-align: left;
  }
  .hint {
    max-width: 220px;
    font-size: var(--text-2xs);
    color: var(--text-faint);
  }
  button.danger,
  button.danger :global(svg) {
    color: var(--status-danger);
  }
  button.danger:hover:not(:disabled),
  button.danger:focus-visible {
    background: var(--status-danger-soft);
    color: var(--status-danger);
  }
  button.danger:focus-visible {
    outline-color: var(--status-danger);
  }
  .separator {
    height: 1px;
    margin: var(--space-1) 0;
    background: var(--border-subtle);
  }
  @media (pointer: coarse) {
    button {
      min-height: 44px;
    }
  }
</style>
