import type { Thread } from "shared/protocol";
import { go, nav, rpc } from "./state.svelte";

/**
 * Deletes a thread once the user confirms, asking again before losing uncommitted changes in its
 * worktrees. Leaves the thread if it was open. Other refusals are thrown for the caller to show.
 */
export async function deleteThread(thread: Thread): Promise<void> {
  const what = thread.workspace ? "this thread and its worktrees (branches are kept)" : "this thread";
  if (!confirm(`Delete ${what}?`)) return;
  try {
    await rpc.request("threads.delete", { threadId: thread.id });
  } catch (cause) {
    const message = (cause as Error).message;
    if (!message.startsWith("Uncommitted changes")) throw cause;
    if (!confirm(`${message}. Delete anyway and lose those changes?`)) return;
    await rpc.request("threads.delete", { threadId: thread.id, force: true });
  }
  if (nav.route.view === "thread" && nav.route.id === thread.id) go({ view: "project", name: thread.project });
}
