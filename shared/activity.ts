// The sidebar's "inactive" and the server's automatic archiving share these, so they never disagree.
import type { LinkedPullRequest, Thread } from "./protocol.ts";

export type PullRequestState = "open" | "merged" | "closed";

/** GitHub's OPEN, MERGED or CLOSED. Pair with the `pr-<state>` colour classes in app.css. */
export function pullRequestState(pr: Pick<LinkedPullRequest, "state">): PullRequestState {
  const state = pr.state.toLowerCase();
  return state === "merged" || state === "closed" ? state : "open";
}

/** A turn ended with something for the user since they last read the thread, or they marked it unread. */
export function isUnread(thread: Pick<Thread, "respondedAt" | "readAt" | "markedUnread">): boolean {
  return thread.markedUnread || (thread.respondedAt !== null && thread.respondedAt > (thread.readAt ?? 0));
}

export type ActivityThread = Pick<Thread, "status" | "waiting" | "respondedAt" | "readAt" | "markedUnread">;

/** Working, waiting on the user, unread, or with an open pull request. */
export function isActive(thread: ActivityThread, pullRequests: Pick<LinkedPullRequest, "state">[] | undefined): boolean {
  return (
    thread.status === "running" ||
    thread.status === "preparing" ||
    thread.waiting ||
    isUnread(thread) ||
    (pullRequests ?? []).some((pr) => pullRequestState(pr) === "open")
  );
}
