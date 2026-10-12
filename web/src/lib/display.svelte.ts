import Bot from "@lucide/svelte/icons/bot";
import FilePen from "@lucide/svelte/icons/file-pen";
import FileText from "@lucide/svelte/icons/file-text";
import GitMerge from "@lucide/svelte/icons/git-merge";
import GitPullRequest from "@lucide/svelte/icons/git-pull-request";
import GitPullRequestClosed from "@lucide/svelte/icons/git-pull-request-closed";
import Globe from "@lucide/svelte/icons/globe";
import ImageIcon from "@lucide/svelte/icons/image";
import ListTodo from "@lucide/svelte/icons/list-todo";
import Plug from "@lucide/svelte/icons/plug";
import Search from "@lucide/svelte/icons/search";
import SquareTerminal from "@lucide/svelte/icons/square-terminal";
import Wrench from "@lucide/svelte/icons/wrench";
import type { ProviderKind, Thread } from "shared/protocol";

/** Ticks once a minute so relative times stay current without repainting every frame. */
export const clock = $state({ now: Date.now() });
setInterval(() => (clock.now = Date.now()), 60_000);

export function relativeTime(timestamp: number): string {
  const minutes = Math.floor((clock.now - timestamp) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

/** A turn ended with something for the user since they last read the thread. */
export function isUnread(thread: Thread): boolean {
  return thread.respondedAt !== null && thread.respondedAt > (thread.readAt ?? 0);
}

export const providerLabel: Record<ProviderKind, string> = { claude: "Claude", codex: "Codex" };

export { pullRequestState, type PullRequestState } from "./pullRequests.ts";

export const pullRequestIcon = { open: GitPullRequest, merged: GitMerge, closed: GitPullRequestClosed };

// Tool names differ by provider: Claude says "Bash" or "mcp__server__tool", Codex "shell" or "server.tool".
export function toolIcon(name: string) {
  const key = name.toLowerCase();
  if (key === "bash" || key === "shell") return SquareTerminal;
  if (key === "read") return FileText;
  if (key === "view image") return ImageIcon;
  if (key === "edit" || key === "write" || key === "multiedit" || key === "notebookedit") return FilePen;
  if (key === "grep" || key === "glob") return Search;
  if (key.startsWith("web")) return Globe;
  if (key === "todowrite") return ListTodo;
  if (key === "task" || key === "agent") return Bot;
  if (key.startsWith("mcp__") || key.includes(".")) return Plug;
  return Wrench;
}

/** "mcp__borkcode__open_pull_requests" and "borkcode.open_pull_requests" both read "open_pull_requests". */
export function toolLabel(name: string): string {
  if (name.startsWith("mcp__")) return name.split("__").slice(2).join("__") || name;
  return name.includes(".") ? name.slice(name.indexOf(".") + 1) : name;
}
