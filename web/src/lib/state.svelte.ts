import type {
  Item,
  LinkedPullRequest,
  ModelOption,
  NetworkState,
  Project,
  ProjectFile,
  ProviderCommand,
  ProviderKind,
  ServerEvent,
  Settings,
  Thread,
  ThreadDetail,
} from "shared/protocol";
import { flushSync, untrack } from "svelte";
import { parseRoute, routeHash, type Route } from "./routes";
import { RpcClient } from "./rpc";
import { prependOlder, upsertItem } from "./transcript";

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

/** Each provider's slash commands for the composer's `/` menu, loaded on first use. */
export const commands = $state<Partial<Record<ProviderKind, ProviderCommand[]>>>({});
const commandRequests = new Map<ProviderKind, Promise<void>>();

export function loadCommands(provider: ProviderKind): Promise<void> {
  let request = commandRequests.get(provider);
  if (!request) {
    request = rpc.request("commands.list", { provider }).then(
      (list) => {
        commands[provider] = list;
      },
      () => {
        // The menu just stays empty; try again next time.
        commandRequests.delete(provider);
      },
    );
    commandRequests.set(provider, request);
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

/** The new-thread page's composer, while it is shown. */
let newThreadComposer: { focus: () => void } | null = null;

export function showingNewThreadComposer(composer: { focus: () => void }): () => void {
  newThreadComposer = composer;
  return () => {
    if (newThreadComposer === composer) newThreadComposer = null;
  };
}

/**
 * Opens a project's new-thread page with its composer focused, for the New thread buttons only;
 * a reload or the back button leaves focus alone. iOS opens the keyboard only for focus within
 * the tap, and `hashchange` arrives after it, so the page is rendered and focused right here.
 */
export function startNewThread(project: string): void {
  const route: Route = { view: "new", project };
  nav.route = route;
  location.hash = routeHash(route);
  flushSync();
  newThreadComposer?.focus();
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
      if (detail?.thread.id === event.threadId) upsertItem(detail, event.item, event.seq, event.toEnd);
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
  // Visibility return replaces the socket before checkPullRequests can send. Wait for cached
  // snapshots to load before checking GitHub, so they cannot overwrite the change broadcasts.
  if (connected) void refresh().then(checkPullRequests);
});

// Coming back to borkcode, often from merging on GitHub, is when merges should show without
// waiting for the next poll. The server throttles it and reports changes as events.
function checkPullRequests(): void {
  if (document.visibilityState !== "visible" || !app.connected) return;
  rpc.request("pullRequests.refresh", {}).catch(() => undefined);
}
document.addEventListener("visibilitychange", checkPullRequests);
window.addEventListener("focus", checkPullRequests);

/** Trimmed items asked for in this tick, per thread, and the request they will share. */
const wanted = new Map<string, { ids: string[]; loaded: Promise<Item[]> }>();

/**
 * Replaces a trimmed tool call in the open thread with the full item, such as when its step is
 * expanded. Steps expanded together share one request. A live upsert that arrived meanwhile is
 * newer, so it is kept.
 */
export async function loadFullItem(threadId: string, itemId: string): Promise<void> {
  let batch = wanted.get(threadId);
  if (!batch) {
    const ids: string[] = [];
    const loaded = Promise.resolve().then(() => {
      wanted.delete(threadId);
      return rpc.request("items.get", { threadId, itemIds: ids });
    });
    batch = { ids, loaded };
    wanted.set(threadId, batch);
  }
  if (!batch.ids.includes(itemId)) batch.ids.push(itemId);
  const items = await batch.loaded;
  const detail = app.detail;
  if (detail?.thread.id !== threadId) return;
  const item = items.find((entry) => entry.id === itemId);
  const index = detail.items.findIndex((entry) => entry.id === itemId);
  if (item && index !== -1 && "trimmed" in detail.items[index]!) detail.items[index] = item;
}

/**
 * Loads the turns before the open thread's earliest, if there are any. Resolves once they are in
 * `app.detail`; `apply` runs just before, so the caller can measure the view on either side.
 */
export async function loadOlderTurns(threadId: string, apply: (change: () => void) => Promise<void>): Promise<void> {
  const detail = app.detail;
  if (detail?.thread.id !== threadId || detail.from === 0) return;
  const before = detail.from;
  const older = await rpc.request("items.older", { threadId, before });
  // The thread was reopened or another load got there first.
  if (app.detail !== detail || detail.from !== before) return;
  await apply(() => prependOlder(detail, older));
}

export async function openThread(id: string): Promise<void> {
  try {
    // Reopening the same thread, as after a reconnect, keeps the older turns it had loaded.
    // Untracked, since effects call this and must not rerun when the transcript changes.
    const from = untrack(() => (app.detail?.thread.id === id ? app.detail.from : undefined));
    app.detail = await rpc.request("threads.get", { threadId: id, ...(from !== undefined && { from }) });
  } catch {
    app.detail = null;
  }
}
