import type { Thread } from "shared/protocol";

type ReadState = Pick<Thread, "id" | "respondedAt" | "readAt" | "markedUnread">;

/** A turn ended with something for the user since they last read the thread, or they marked it unread. */
export function isUnread(thread: Omit<ReadState, "id">): boolean {
  return thread.markedUnread || (thread.respondedAt !== null && thread.respondedAt > (thread.readAt ?? 0));
}

/**
 * Keeps the open thread from being read automatically right after the user marked it unread.
 * It holds the response the thread had then, so a new response lifts it.
 */
export type ReadHold = { threadId: string; respondedAt: number | null } | null;

/**
 * The hold after the open thread changes. It starts when the thread open as `openId` becomes
 * marked unread while open, from any device, and ends when the user opens another thread.
 */
export function nextHold(hold: ReadHold, openId: string, previous: ReadState | undefined, current: ReadState | undefined): ReadHold {
  if (previous?.id === openId && current?.id === openId && !previous.markedUnread && current.markedUnread) {
    return { threadId: openId, respondedAt: current.respondedAt };
  }
  return hold?.threadId === openId ? hold : null;
}

/** Whether having the thread open should mark it read. */
export function autoReadDue(thread: ReadState, hold: ReadHold): boolean {
  return isUnread(thread) && !(hold?.threadId === thread.id && hold.respondedAt === thread.respondedAt);
}
