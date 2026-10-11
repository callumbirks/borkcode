<script lang="ts">
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import FileText from "@lucide/svelte/icons/file-text";
  import Folder from "@lucide/svelte/icons/folder";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import type { ProjectFile } from "shared/protocol";
  import { SvelteSet } from "svelte/reactivity";
  import { relativeTime } from "../lib/display.svelte";
  import { go, rpc } from "../lib/state.svelte";

  let { project, files }: { project: string; files: ProjectFile[] } = $props();

  interface FolderNode {
    name: string;
    path: string;
    folders: FolderNode[];
    files: { name: string; file: ProjectFile }[];
    count: number;
    modifiedAt: number;
  }

  // The server lists files only; folders are implied by their paths.
  const tree = $derived.by(() => {
    const root: FolderNode = { name: "", path: "", folders: [], files: [], count: 0, modifiedAt: 0 };
    for (const file of files) {
      const parts = file.path.split("/");
      let node = root;
      for (const part of parts.slice(0, -1)) {
        node.count++;
        node.modifiedAt = Math.max(node.modifiedAt, file.modifiedAt);
        let next = node.folders.find((folder) => folder.name === part);
        if (!next) {
          next = { name: part, path: node.path ? `${node.path}/${part}` : part, folders: [], files: [], count: 0, modifiedAt: 0 };
          node.folders.push(next);
        }
        node = next;
      }
      node.count++;
      node.modifiedAt = Math.max(node.modifiedAt, file.modifiedAt);
      node.files.push({ name: parts.at(-1)!, file });
    }
    const sort = (node: FolderNode) => {
      node.folders.sort((a, b) => a.name.localeCompare(b.name));
      node.files.sort((a, b) => a.name.localeCompare(b.name));
      node.folders.forEach(sort);
    };
    sort(root);
    return root;
  });

  const open = new SvelteSet<string>();
  let error = $state("");

  function toggle(path: string) {
    if (open.has(path)) open.delete(path);
    else open.add(path);
  }

  async function removeFolder(folder: FolderNode) {
    const what = folder.count === 1 ? "the file" : `all ${folder.count} files`;
    if (!confirm(`Delete ${folder.path}/ and ${what} in it? Every thread of ${project} shares them.`)) return;
    error = "";
    try {
      await rpc.request("files.deleteFolder", { project, path: folder.path });
      open.delete(folder.path);
    } catch (cause) {
      error = (cause as Error).message;
    }
  }

  function formatSize(bytes: number): string {
    return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
  }
</script>

{#snippet contents(node: FolderNode, depth: number)}
  {#each node.folders as folder (folder.path)}
    {@const expanded = open.has(folder.path)}
    <div class="row folder" style:padding-left="calc(var(--space-2) + {depth} * var(--space-4))">
      <button class="toggle" onclick={() => toggle(folder.path)} aria-expanded={expanded}>
        <span class="chevron" class:expanded><ChevronRight size={14} /></span>
        {#if expanded}<FolderOpen size={16} />{:else}<Folder size={16} />{/if}
        <span class="truncate grow">{folder.name}</span>
        <span class="meta">{folder.count} {folder.count === 1 ? "file" : "files"}</span>
        <span class="meta">{relativeTime(folder.modifiedAt)}</span>
      </button>
      <button class="ghost icon delete" title="Delete {folder.path}/" onclick={() => removeFolder(folder)}>
        <Trash2 size={14} />
      </button>
    </div>
    {#if expanded}{@render contents(folder, depth + 1)}{/if}
  {/each}
  {#each node.files as { name, file } (file.path)}
    <button
      class="row file"
      style:padding-left="calc(var(--space-2) + {depth} * var(--space-4) + 18px)"
      onclick={() => go({ view: "file", project, path: file.path })}
    >
      <FileText size={16} class="muted" />
      <span class="truncate grow">{name}</span>
      <span class="meta">{formatSize(file.size)}</span>
      <span class="meta">{relativeTime(file.modifiedAt)}</span>
    </button>
  {/each}
{/snippet}

<div class="tree">
  {@render contents(tree, 0)}
</div>
{#if error}<p class="error">{error}</p>{/if}

<style>
  .tree {
    display: flex;
    flex-direction: column;
    margin: 0 calc(-1 * var(--space-2));
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    min-height: 32px;
    border-radius: var(--radius-md);
  }
  .row:hover {
    background: var(--surface-hover);
  }
  .file,
  .toggle {
    padding-top: var(--space-1);
    padding-bottom: var(--space-1);
    padding-right: var(--space-2);
    background: none;
    border: none;
    text-align: left;
    font-weight: var(--weight-regular);
    justify-content: flex-start;
    gap: var(--space-2);
  }
  .toggle {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    padding-left: 0;
  }
  .toggle:hover:not(:disabled) {
    background: none;
  }
  .chevron {
    display: inline-flex;
    color: var(--text-faint);
    transition: transform var(--transition-fast);
  }
  .chevron.expanded {
    transform: rotate(90deg);
  }
  .meta {
    flex-shrink: 0;
    font-size: var(--text-xs);
    color: var(--text-faint);
  }
  .delete {
    flex-shrink: 0;
    margin-right: var(--space-1);
    opacity: 0;
  }
  .row:hover .delete,
  .delete:focus-visible {
    opacity: 1;
  }
  .delete:hover:not(:disabled) {
    color: var(--status-danger);
  }
</style>
