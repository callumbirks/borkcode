<script lang="ts">
  import type { SidebarFilter } from "../lib/sidebarFilter";

  let {
    anchor,
    projects,
    filter,
    onchange,
    onclose,
  }: {
    anchor: HTMLElement;
    projects: string[];
    filter: SidebarFilter;
    onchange: (filter: SidebarFilter) => void;
    onclose: () => void;
  } = $props();

  let position = $state({ left: 0, top: 0 });

  // Before closing, since the parent clears the anchor prop when it closes the popover.
  function close() {
    anchor.focus({ preventScroll: true });
    onclose();
  }

  function setProject(name: string, included: boolean) {
    const excluded = filter.excludedProjects.filter((entry) => entry !== name);
    onchange({ ...filter, excludedProjects: included ? excluded : [...excluded, name] });
  }

  // Escape would otherwise also close the phone drawer behind the popover.
  function onKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  /** In the body for the same reason as ContextMenu: the sidebar's layer traps fixed children. */
  function place(node: HTMLDivElement) {
    document.body.append(node);
    const { width, height } = node.getBoundingClientRect();
    const below = anchor.getBoundingClientRect();
    position = {
      left: Math.max(4, Math.min(below.left, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(below.bottom + 4, window.innerHeight - height - 4)),
    };
    node.querySelector<HTMLElement>("input, button")?.focus();
    // The anchor toggles the popover itself, so pressing it is not a press outside.
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!node.contains(target) && !anchor.contains(target)) onclose();
    };
    // Tabbing out of the popover closes it, as clicking elsewhere does.
    const focusout = (event: FocusEvent) => {
      const target = event.relatedTarget;
      if (target instanceof Node && !node.contains(target) && !anchor.contains(target)) onclose();
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", onclose);
    node.addEventListener("focusout", focusout);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", onclose);
      node.removeEventListener("focusout", focusout);
      node.remove();
    };
  }
</script>

<div
  class="popover"
  role="dialog"
  aria-label="Filter threads"
  tabindex="-1"
  style:left="{position.left}px"
  style:top="{position.top}px"
  onkeydown={onKeydown}
  {@attach place}
>
  <label class="option switch">
    <span class="text">Hide inactive threads<span class="hint">Read, idle, no open PR, not a captain</span></span>
    <input
      type="checkbox"
      role="switch"
      checked={filter.hideInactive}
      onchange={(event) => onchange({ ...filter, hideInactive: event.currentTarget.checked })}
    />
    <span class="track"></span>
  </label>
  <div class="separator" role="separator"></div>
  <div class="heading">
    <span>Projects</span>
    <button class="ghost" onclick={() => onchange({ ...filter, excludedProjects: [] })}>All</button>
    <button class="ghost" onclick={() => onchange({ ...filter, excludedProjects: [...projects] })}>None</button>
  </div>
  <div class="projects">
    {#each projects as name (name)}
      <label class="option">
        <input
          type="checkbox"
          checked={!filter.excludedProjects.includes(name)}
          onchange={(event) => setProject(name, event.currentTarget.checked)}
        />
        <span class="truncate">{name}</span>
      </label>
    {/each}
  </div>
</div>

<style>
  .popover {
    position: fixed;
    z-index: 50;
    display: flex;
    flex-direction: column;
    width: 240px;
    max-height: calc(var(--viewport-height, 100vh) - 8px);
    padding: var(--space-1);
    background: var(--surface-overlay);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
    font-size: var(--text-sm);
  }
  .option {
    font-size: var(--text-sm);
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
    min-height: 32px;
    padding: 0 var(--space-2);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    cursor: pointer;
  }
  .option:hover {
    background: var(--surface-hover);
  }
  .option input[type="checkbox"]:not([role="switch"]) {
    flex-shrink: 0;
    margin: 0;
    accent-color: var(--accent);
  }
  .text {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: var(--space-1) 0;
  }
  .hint {
    font-size: var(--text-2xs);
    color: var(--text-faint);
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
  .separator {
    height: 1px;
    margin: var(--space-1) 0;
    background: var(--border-subtle);
  }
  .heading {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: 0 0 0 var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .heading span {
    flex: 1;
  }
  .heading button {
    min-height: 28px;
    padding: 0 var(--space-2);
    font-size: var(--text-xs);
    font-weight: var(--weight-regular);
  }
  .projects {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
  }
  @media (pointer: coarse) {
    .option,
    .heading button {
      min-height: 44px;
    }
    .option input[type="checkbox"]:not([role="switch"]) {
      width: 18px;
      height: 18px;
    }
  }
</style>
