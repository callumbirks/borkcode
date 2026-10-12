import type { Thread } from "shared/protocol";

/** The first thread in `threadId`'s subtree that is working, which blocks archiving it. */
export function workingInSubtree(threads: Pick<Thread, "id" | "parentId" | "status" | "title">[], threadId: string) {
  const ids = new Set([threadId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const thread of threads) {
      if (thread.parentId && ids.has(thread.parentId) && !ids.has(thread.id)) {
        ids.add(thread.id);
        grew = true;
      }
    }
  }
  return threads.find((thread) => ids.has(thread.id) && (thread.status === "running" || thread.status === "preparing"));
}
