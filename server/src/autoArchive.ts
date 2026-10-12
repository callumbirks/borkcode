import { isActive } from "shared/activity";
import type { AutoArchive, LinkedPullRequest, Thread } from "shared/protocol";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How often inactive threads are looked for, besides at start and when the setting changes. */
export const AUTO_ARCHIVE_INTERVAL_MS = 60 * 60 * 1000;

type ArchiveThread = Pick<
  Thread,
  "id" | "parentId" | "archivedAt" | "captain" | "status" | "waiting" | "respondedAt" | "readAt" | "markedUnread" | "updatedAt"
>;

/**
 * The last time the user or an agent did anything with the thread: `updatedAt` covers turns,
 * delivered messages and pull request merges and closes (which wake the thread), and `readAt`
 * covers the user reading it.
 */
export function lastActivity(thread: Pick<Thread, "updatedAt" | "readAt">): number {
  return Math.max(thread.updatedAt, thread.readAt ?? 0);
}

/**
 * The threads to archive, each taking its subtree along: inactive, as the sidebar means it, with
 * no activity for `days` days, and the same for every unarchived thread below. Only the topmost
 * such thread is named, so a child is archived on its own only when its parent stays.
 */
export function threadsToArchive(
  threads: ArchiveThread[],
  pullRequests: (threadId: string) => LinkedPullRequest[],
  days: number,
  now: number,
): string[] {
  const cutoff = now - days * DAY_MS;
  const shown = threads.filter((thread) => thread.archivedAt === null);
  const children = new Map<string, ArchiveThread[]>();
  for (const thread of shown) {
    if (thread.parentId) children.set(thread.parentId, [...(children.get(thread.parentId) ?? []), thread]);
  }
  const done = new Map<string, boolean>();
  const isDone = (thread: ArchiveThread): boolean => {
    let result = done.get(thread.id);
    if (result === undefined) {
      done.set(thread.id, false);
      result =
        !isActive(thread, pullRequests(thread.id)) &&
        lastActivity(thread) < cutoff &&
        (children.get(thread.id) ?? []).every(isDone);
      done.set(thread.id, result);
    }
    return result;
  };
  const byId = new Map(shown.map((thread) => [thread.id, thread]));
  return shown
    .filter((thread) => {
      const parent = thread.parentId ? byId.get(thread.parentId) : undefined;
      return isDone(thread) && !(parent && isDone(parent));
    })
    .map((thread) => thread.id);
}

/** Turning archiving on or shortening or lengthening its wait runs it at once. */
export function autoArchiveChanged(previous: AutoArchive, next: AutoArchive): boolean {
  return next.enabled && (!previous.enabled || previous.days !== next.days);
}
