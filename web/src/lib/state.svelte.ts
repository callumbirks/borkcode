import type {
  LinkedPullRequest,
  ModelOption,
  NetworkState,
  Project,
  ProjectFile,
  ProviderKind,
  ServerEvent,
  Settings,
  Thread,
  ThreadDetail,
} from "shared/protocol";
import { parseRoute, routeHash, type Route } from "./routes";
import { RpcClient } from "./rpc";

export const app = $state({
  connected: false,
  network: null as NetworkState | null,
  projects: [] as Project[],
  threads: [] as Thread[],
  /** Every thread's linked pull requests, keyed by thread id, oldest first. */
  pullRequests: {} as Record<string, LinkedPullRequest[]>,
  /** The open thread's transcript, pending approvals and questions. */
  detail: null as ThreadDetail | null,
  settings: null as Settings | null,
  settingsError: null as string | null,
  /** Shared files per project, loaded when a project's page opens and kept current by events. */
  files: {} as Record<string, ProjectFile[]>,
});

export async function loadFiles(project: string): Promise<void> {
  app.files[project] = await rpc.request("files.list", { project });
}

/**
 * Unsent composer text per thread. It belongs to this browser rather than the server, so it lives
 * in localStorage and survives switching threads and reloading.
 */
const draftsKey = "borkcode.drafts";
const drafts = $state<Record<string, string>>(loadDrafts());

function loadDrafts(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(draftsKey) ?? "{}");
  } catch {
    return {};
  }
}

export function getDraft(threadId: string): string {
  return drafts[threadId] ?? "";
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function saveDrafts() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  localStorage.setItem(draftsKey, JSON.stringify(drafts));
}

/** Drafts change on every keystroke, so writing them all to localStorage waits for a pause. */
export function setDraft(threadId: string, text: string): void {
  if (text) drafts[threadId] = text;
  else delete drafts[threadId];
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDrafts, 300);
}

addEventListener("pagehide", () => saveTimer !== undefined && saveDrafts());

/** Each provider's model list, loaded on first use. */
export const models = $state<Partial<Record<ProviderKind, { list: ModelOption[]; error: string | null }>>>({});
const modelRequests = new Map<ProviderKind, Promise<void>>();

export function loadModels(provider: ProviderKind): Promise<void> {
  let request = modelRequests.get(provider);
  if (!request) {
    request = rpc.request("models.list", { provider }).then(
      (list) => {
        models[provider] = { list, error: null };
      },
      (cause: Error) => {
        models[provider] = { list: [], error: cause.message };
        // Try again next time, for example once the CLI is installed or the server is back.
        modelRequests.delete(provider);
      },
    );
    modelRequests.set(provider, request);
  }
  return request;
}

export type { Route } from "./routes";

export const nav = $state({ route: parseRoute(location.hash) });
window.addEventListener("hashchange", () => {
  nav.route = parseRoute(location.hash);
});

export function go(route: Route): void {
  location.hash = routeHash(route);
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
    case "files.changed":
      app.files[event.project] = event.files;
      return;
    case "network.changed":
      app.network = event.network;
      break;
    case "settings.changed":
      app.settings = event.settings;
      app.settingsError = null;
      return;
    case "thread.updated":
      upsertById(app.threads, event.thread);
      if (detail?.thread.id === event.thread.id) detail.thread = event.thread;
      return;
    case "thread.deleted":
      app.threads = app.threads.filter((thread) => thread.id !== event.threadId);
      setDraft(event.threadId, "");
      delete app.pullRequests[event.threadId];
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
    case "pullRequests.changed":
      app.pullRequests[event.threadId] = event.pullRequests;
      return;
    case "approval.resolved":
      if (detail?.thread.id === event.threadId) {
        detail.approvals = detail.approvals.filter((approval) => approval.id !== event.approvalId);
      }
      return;
    case "question.requested":
      if (detail?.thread.id === event.threadId) upsertById(detail.questions, event.question);
      return;
    case "question.resolved":
      if (detail?.thread.id === event.threadId) {
        detail.questions = detail.questions.filter((question) => question.id !== event.questionId);
      }
      return;
  }
}

async function refresh(): Promise<void> {
  // A broken settings.json should not keep projects and threads from loading.
  void rpc.request("network.get", {}).then((state) => app.network = state).catch(() => undefined);
  void rpc.request("settings.get", {}).then(
    (settings) => {
      app.settings = settings;
      app.settingsError = null;
    },
    (cause: Error) => {
      app.settingsError = cause.message;
    },
  );
  const [projects, threads, pullRequests] = await Promise.all([
    rpc.request("projects.list", {}),
    rpc.request("threads.list", {}),
    rpc.request("pullRequests.list", {}),
  ]);
  app.projects = projects;
  app.threads = threads;
  app.pullRequests = pullRequests;
  if (nav.route.view === "thread") await openThread(nav.route.id);
}

export const rpc = new RpcClient(handleEvent, (connected) => {
  app.connected = connected;
  if (connected) void refresh();
});

// Coming back to borkcode, often from merging on GitHub, is when merges should show without
// waiting for the next poll. The server throttles it and reports changes as events.
function checkPullRequests(): void {
  if (document.visibilityState !== "visible" || !app.connected) return;
  rpc.request("pullRequests.refresh", {}).catch(() => undefined);
}
document.addEventListener("visibilitychange", checkPullRequests);
window.addEventListener("focus", checkPullRequests);

export async function openThread(id: string): Promise<void> {
  try {
    app.detail = await rpc.request("threads.get", { threadId: id });
  } catch {
    app.detail = null;
  }
}
