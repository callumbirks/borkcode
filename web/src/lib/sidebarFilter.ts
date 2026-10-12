import type { LinkedPullRequest, Thread } from "shared/protocol";
import { pullRequestState } from "./pullRequests.ts";
import { isUnread } from "./unread.ts";

/**
 * The sidebar's thread filter, kept per device. Excluded rather than included projects are
 * stored, so a new project shows up without touching the filter.
 */
export type SidebarFilter = { excludedProjects: string[]; hideInactive: boolean };

export const defaultFilter: SidebarFilter = { excludedProjects: [], hideInactive: true };

export function isDefaultFilter(filter: SidebarFilter): boolean {
  return filter.excludedProjects.length === 0 && filter.hideInactive === defaultFilter.hideInactive;
}

/** Whatever localStorage held, or the defaults for anything missing or malformed. */
export function parseFilter(stored: string | null): SidebarFilter {
  try {
    const value = JSON.parse(stored ?? "{}");
    return {
      excludedProjects: Array.isArray(value.excludedProjects)
        ? value.excludedProjects.filter((name: unknown) => typeof name === "string")
        : defaultFilter.excludedProjects,
      hideInactive: typeof value.hideInactive === "boolean" ? value.hideInactive : defaultFilter.hideInactive,
    };
  } catch {
    return defaultFilter;
  }
}

type FilterThread = Pick<Thread, "id" | "parentId" | "project" | "status" | "waiting" | "respondedAt" | "readAt" | "markedUnread">;

/** Working, waiting on the user, unread, or with an open pull request. */
export function isActive(thread: FilterThread, pullRequests: LinkedPullRequest[] | undefined): boolean {
  return (
    thread.status === "running" ||
    thread.status === "preparing" ||
    thread.waiting ||
    isUnread(thread) ||
    (pullRequests ?? []).some((pr) => pullRequestState(pr) === "open")
  );
}

/**
 * The threads the sidebar lists, in their given order, and how many each shown project hides.
 * Threads in `keep` (the open one) are listed even if inactive, and a listed thread lists its
 * ancestors too, so nesting stays intact. `showInactiveIn` names projects whose inactive threads
 * the user revealed for now. Excluded projects list nothing and count nothing.
 */
export function filterThreads<T extends FilterThread>(
  threads: T[],
  options: {
    filter: SidebarFilter;
    pullRequests: Record<string, LinkedPullRequest[]>;
    keep?: Iterable<string>;
    showInactiveIn?: ReadonlySet<string>;
  },
): { shown: T[]; hidden: Map<string, number> } {
  const excluded = new Set(options.filter.excludedProjects);
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const keep = new Set(options.keep);
  const ids = new Set<string>();
  const show = (thread: T | undefined) => {
    for (let at = thread; at && !ids.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) ids.add(at.id);
  };
  for (const thread of threads) {
    if (excluded.has(thread.project)) continue;
    if (
      !options.filter.hideInactive ||
      options.showInactiveIn?.has(thread.project) ||
      keep.has(thread.id) ||
      isActive(thread, options.pullRequests[thread.id])
    ) {
      show(thread);
    }
  }
  const shown = threads.filter((thread) => ids.has(thread.id) && !excluded.has(thread.project));
  const hidden = new Map<string, number>();
  for (const thread of threads) {
    if (!ids.has(thread.id) && !excluded.has(thread.project)) hidden.set(thread.project, (hidden.get(thread.project) ?? 0) + 1);
  }
  return { shown, hidden };
}
