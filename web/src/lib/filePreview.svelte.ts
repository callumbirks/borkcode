import type { FileTarget } from "shared/protocol";
import { fileUrl, type FileLinker, type PreviewTarget } from "./fileLinks";
import { rpc } from "./state.svelte";

/**
 * What the server said each path written in a thread points at, keyed by thread and path. Null is
 * "not a file of this thread". Paths are asked about in batches as messages render them.
 */
const located = $state<Record<string, FileTarget | null>>({});
const asked = new Set<string>();
let queue: { threadId: string; path: string }[] = [];

const key = (threadId: string, path: string) => `${threadId}\n${path}`;
const BATCH = 200;

async function flush(): Promise<void> {
  const batch = queue;
  queue = [];
  for (const threadId of new Set(batch.map((entry) => entry.threadId))) {
    const all = batch.filter((entry) => entry.threadId === threadId).map((entry) => entry.path);
    for (let at = 0; at < all.length; at += BATCH) {
      const paths = all.slice(at, at + BATCH);
      const found = await rpc.request("threads.locateFiles", { threadId, paths }).catch(() => paths.map(() => null));
      paths.forEach((path, index) => (located[key(threadId, path)] = found[index] ?? null));
    }
  }
}

/** Links paths in a thread's messages once the server has found them; re-renders when it has. */
export function linker(threadId: string): FileLinker {
  return {
    find(path) {
      const k = key(threadId, path);
      const found = located[k];
      if (found !== undefined || asked.has(k)) return found ?? null;
      asked.add(k);
      if (queue.length === 0) queueMicrotask(() => void flush());
      queue.push({ threadId, path });
      return null;
    },
    href: (target) => fileUrl(threadId, target),
  };
}

/** Paths that named nothing may name a file now, so they are asked about again when a thread opens. */
export function forgetMissing(threadId: string): void {
  for (const k of Object.keys(located)) {
    if (k.startsWith(`${threadId}\n`) && located[k] === null) {
      delete located[k];
      asked.delete(k);
    }
  }
}

/** The file each thread's preview panel shows. Per browser tab: it's a view, not thread state. */
export const previews = $state<Record<string, PreviewTarget>>({});

const widthKey = "borkcode.previewWidth";
export const previewLayout = $state({ width: Number(localStorage.getItem(widthKey)) || 560 });

export function setPreviewWidth(width: number): void {
  previewLayout.width = Math.round(Math.min(Math.max(width, 320), window.innerWidth - 400));
  localStorage.setItem(widthKey, String(previewLayout.width));
}

/** Opens the preview for a click on a rendered file link, unless the user asked for a new tab. */
export function openFileLink(threadId: string, event: MouseEvent): void {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const link = (event.target as Element).closest<HTMLElement>("[data-file-path]");
  if (!link) return;
  event.preventDefault();
  const [start, end] = (link.dataset.fileLines ?? "").split("-").map(Number);
  previews[threadId] = {
    root: link.dataset.fileRoot === "project" ? "project" : "workspace",
    path: link.dataset.filePath ?? "",
    lines: start ? { start, end: end || start } : null,
  };
}
