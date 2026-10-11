import type { Project, ServerEvent, Thread, ThreadDetail } from "shared/protocol";
import { RpcClient } from "./rpc";

export const app = $state({
  connected: false,
  projects: [] as Project[],
  threads: [] as Thread[],
  /** The open thread's transcript and pending approvals. */
  detail: null as ThreadDetail | null,
});

export type Route =
  | { view: "home" }
  | { view: "project"; name: string }
  | { view: "thread"; id: string };

function parseRoute(): Route {
  const [, view, id] = location.hash.split("/");
  if (view === "project" && id) return { view: "project", name: decodeURIComponent(id) };
  if (view === "thread" && id) return { view: "thread", id };
  return { view: "home" };
}

export const nav = $state({ route: parseRoute() });
window.addEventListener("hashchange", () => {
  nav.route = parseRoute();
});

export function go(route: Route): void {
  location.hash =
    route.view === "home"
      ? "#/"
      : route.view === "project"
        ? `#/project/${encodeURIComponent(route.name)}`
        : `#/thread/${route.id}`;
}

function upsertById<T extends { id: string }>(list: T[], value: T): void {
  const index = list.findIndex((entry) => entry.id === value.id);
  if (index === -1) list.push(value);
  else list[index] = value;
}

function handleEvent(event: ServerEvent): void {
  const detail = app.detail;
  switch (event.type) {
    case "projects.changed":
      app.projects = event.projects;
      return;
    case "thread.updated":
      upsertById(app.threads, event.thread);
      if (detail?.thread.id === event.thread.id) detail.thread = event.thread;
      return;
    case "thread.deleted":
      app.threads = app.threads.filter((thread) => thread.id !== event.threadId);
      if (detail?.thread.id === event.threadId) app.detail = null;
      return;
    case "item.upserted":
      if (detail?.thread.id === event.threadId) upsertById(detail.items, event.item);
      return;
    case "item.delta": {
      if (detail?.thread.id !== event.threadId) return;
      const item = detail.items.find((entry) => entry.id === event.itemId);
      if (item && (item.kind === "assistant" || item.kind === "reasoning")) item.text += event.text;
      return;
    }
    case "approval.requested":
      if (detail?.thread.id === event.threadId) upsertById(detail.approvals, event.approval);
      return;
    case "approval.resolved":
      if (detail?.thread.id === event.threadId) {
        detail.approvals = detail.approvals.filter((approval) => approval.id !== event.approvalId);
      }
      return;
  }
}

async function refresh(): Promise<void> {
  const [projects, threads] = await Promise.all([
    rpc.request("projects.list", {}),
    rpc.request("threads.list", {}),
  ]);
  app.projects = projects;
  app.threads = threads;
  if (nav.route.view === "thread") await openThread(nav.route.id);
}

export const rpc = new RpcClient(handleEvent, (connected) => {
  app.connected = connected;
  if (connected) void refresh();
});

export async function openThread(id: string): Promise<void> {
  try {
    app.detail = await rpc.request("threads.get", { threadId: id });
  } catch {
    app.detail = null;
  }
}
