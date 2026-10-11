import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  Approval,
  Item,
  Project,
  ProviderKind,
  RepoConfig,
  RepoStatus,
  Requests,
  ServerEvent,
  Thread,
  ThreadDetail,
} from "shared/protocol";
import { toThread, type Database, type StoredThread } from "./db.ts";
import { buildInstructions } from "./instructions.ts";
import type { ProjectStore } from "./projects.ts";
import { startClaudeSession } from "./providers/claude.ts";
import { startCodexSession } from "./providers/codex.ts";
import type { ProviderSession, SessionOptions, TurnSettings } from "./providers/types.ts";
import type { SettingsStore } from "./settings.ts";
import { fallbackTitle, generateTitle } from "./titles.ts";
import {
  dirtyRepos,
  ensureWorkspace,
  mainRepoPath,
  removeWorkspace,
  repoStatuses,
  runRepoSetup,
  WorkspaceDirtyError,
  workspacePath,
} from "./workspaces.ts";

const startSession: Record<ProviderKind, (options: SessionOptions) => Promise<ProviderSession>> = {
  claude: startClaudeSession,
  codex: startCodexSession,
};

/** In-memory state for a thread whose agent may be active. */
interface LiveThread {
  session: Promise<ProviderSession> | null;
  preparing: Promise<void> | null;
  /** Streaming assistant/reasoning items of the current turn, ahead of the database. */
  streaming: Map<string, Item>;
  approvals: Map<string, { approval: Approval; resolve: (allowed: boolean) => void }>;
}

export function workspaceSlug(title: string, id: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `${base || "thread"}-${id.slice(0, 6)}`;
}

export class ThreadService {
  readonly #db: Database;
  readonly #projects: ProjectStore;
  readonly #settings: SettingsStore;
  readonly #emit: (event: ServerEvent) => void;
  readonly #live = new Map<string, LiveThread>();

  constructor(
    db: Database,
    projects: ProjectStore,
    settings: SettingsStore,
    emit: (event: ServerEvent) => void,
  ) {
    this.#db = db;
    this.#projects = projects;
    this.#settings = settings;
    this.#emit = emit;
  }

  list(): Thread[] {
    return this.#db.listThreads().map(toThread);
  }

  /** Starts the thread on its first message. The title is generated in the background. */
  async create(params: Requests["threads.create"]["params"]): Promise<Thread> {
    const project = await this.#projects.get(params.project);
    const text = params.text.trim();
    if (!text) throw new Error("Write the first message for the agent");
    const id = randomUUID();
    // A provisional workspace name until the title is generated. Nothing is on disk before then,
    // so renaming is free, and a restart in between leaves a usable name.
    const workspace = params.isolated ? workspaceSlug("", id) : null;
    const now = Date.now();
    const thread: StoredThread = {
      id,
      project: project.name,
      title: fallbackTitle(text),
      provider: params.provider,
      model: params.model,
      effort: params.effort,
      accessMode: params.accessMode,
      workspace,
      branch: workspace ? `borkcode/${workspace}` : null,
      status: workspace ? "preparing" : "idle",
      providerSessionId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#db.insertThread(thread);
    this.#emit({ type: "thread.updated", thread: toThread(thread) });
    const live = this.#liveThread(id);
    // The workspace is named after the title, so it waits; main checkouts need no naming.
    const naming = this.#nameThread(id, text, thread.title, workspace !== null);
    if (workspace) {
      live.preparing = naming
        .then(() => this.#prepare(id))
        .finally(() => {
          live.preparing = null;
        });
    }
    void this.send(id, text, { model: thread.model, effort: thread.effort }).catch((error: Error) =>
      console.error(error),
    );
    return toThread(thread);
  }

  rename(threadId: string, title: string): Thread {
    this.#require(threadId);
    const trimmed = title.trim();
    if (!trimmed) throw new Error("A thread needs a title");
    return toThread(this.#update(threadId, { title: trimmed }));
  }

  async get(threadId: string): Promise<ThreadDetail> {
    const thread = this.#require(threadId);
    const project = await this.#projects.get(thread.project);
    const live = this.#live.get(threadId);
    const items = this.#db
      .listItems(threadId)
      .map((item) => live?.streaming.get(item.id) ?? item);
    return {
      thread: toThread(thread),
      workspacePath: workspacePath(project, thread.workspace),
      items,
      approvals: [...(live?.approvals.values() ?? [])].map((entry) => entry.approval),
    };
  }

  async send(threadId: string, text: string, settings: TurnSettings): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    let thread = this.#require(threadId);
    if (thread.status === "running") throw new Error("The agent is still working on the last message");
    const live = this.#liveThread(threadId);
    this.#upsertItem(threadId, { id: randomUUID(), kind: "user", text: trimmed });
    await live.preparing;
    thread = this.#update(threadId, { status: "running", model: settings.model, effort: settings.effort });

    try {
      // Fills in repos added to the project since the workspace was created.
      if (thread.workspace) await this.#addMissingRepos(thread);
      live.session ??= this.#openSession(thread);
      const session = await live.session;
      await session.sendTurn(trimmed, { model: thread.model, effort: thread.effort });
    } catch (error) {
      const session = live.session;
      live.session = null;
      void session?.then((open) => open.close(), () => undefined);
      this.#notice(threadId, "error", error instanceof Error ? error.message : String(error));
      this.#setStatus(threadId, "idle");
    }
  }

  async interrupt(threadId: string): Promise<void> {
    const live = this.#live.get(threadId);
    this.#declineApprovals(threadId);
    if (live?.session) await (await live.session).interrupt();
  }

  respondToApproval(threadId: string, approvalId: string, allowed: boolean): void {
    const entry = this.#live.get(threadId)?.approvals.get(approvalId);
    if (!entry) throw new Error("That approval is no longer pending");
    entry.resolve(allowed);
  }

  async delete(threadId: string, force: boolean): Promise<void> {
    const thread = this.#require(threadId);
    const live = this.#live.get(threadId);
    await live?.preparing;
    const project = await this.#projects.get(thread.project);
    if (thread.workspace && !force) {
      const dirty = await dirtyRepos(project, thread.workspace);
      if (dirty.length > 0) throw new WorkspaceDirtyError(dirty);
    }
    // Stop the agent before its workspace disappears underneath it.
    this.#declineApprovals(threadId);
    if (live?.session) (await live.session.catch(() => null))?.close();
    this.#live.delete(threadId);
    if (thread.workspace) await removeWorkspace(project, thread.workspace, true);
    this.#db.deleteThread(threadId);
    this.#emit({ type: "thread.deleted", threadId });
  }

  async repoStatus(threadId: string): Promise<RepoStatus[]> {
    const thread = this.#require(threadId);
    return repoStatuses(await this.#projects.get(thread.project), thread.workspace);
  }

  /** Replaces the provisional title and, before a workspace exists, the workspace name too. */
  async #nameThread(threadId: string, text: string, provisional: string, renameWorkspace: boolean): Promise<void> {
    let generated: string | null = null;
    try {
      generated = await generateTitle(text, (await this.#settings.get()).titleModel);
    } catch (error) {
      this.#notice(threadId, "info", `Could not generate a title: ${error instanceof Error ? error.message : String(error)}`);
    }
    const thread = this.#db.getThread(threadId);
    if (!thread) return;
    // A manual rename made while the title was generating wins.
    const title = generated && thread.title === provisional ? generated : thread.title;
    const workspace = renameWorkspace ? workspaceSlug(title, threadId) : thread.workspace;
    if (title === thread.title && workspace === thread.workspace) return;
    this.#update(threadId, { title, workspace, branch: workspace ? `borkcode/${workspace}` : null });
  }

  async #prepare(threadId: string): Promise<void> {
    if (!this.#db.getThread(threadId)) return;
    try {
      await this.#addMissingRepos(this.#require(threadId));
      this.#setStatus(threadId, "idle");
    } catch (error) {
      this.#notice(threadId, "error", `Could not create the workspace: ${error instanceof Error ? error.message : String(error)}`);
      this.#setStatus(threadId, "error");
    }
  }

  async #addMissingRepos(thread: StoredThread): Promise<void> {
    if (!thread.workspace || !thread.branch) return;
    const project = await this.#projects.get(thread.project);
    const created = await ensureWorkspace(project, thread.workspace, thread.branch);
    for (const repo of created) {
      if (repo.setup) await this.#runSetup(thread, project, repo);
    }
  }

  async #runSetup(thread: StoredThread, project: Project, repo: RepoConfig): Promise<void> {
    const item: Extract<Item, { kind: "tool" }> = {
      id: randomUUID(),
      kind: "tool",
      name: "setup",
      summary: `${repo.name}: ${repo.setup}`,
      output: null,
      status: "running",
    };
    this.#upsertItem(thread.id, item);
    const result = await runRepoSetup(project, thread.workspace!, repo);
    this.#upsertItem(thread.id, {
      ...item,
      output: result.output.slice(-8000),
      status: result.code === 0 ? "done" : "failed",
    });
  }

  async #openSession(thread: StoredThread): Promise<ProviderSession> {
    const project = await this.#projects.get(thread.project);
    const cwd = workspacePath(project, thread.workspace);
    const writableRoots = [join(project.path, "files")];
    if (thread.workspace) {
      // Worktree commits write into the main clone's .git directory, outside the workspace.
      for (const repo of project.repos) {
        const gitDir = join(mainRepoPath(project, repo), ".git");
        if (existsSync(gitDir)) writableRoots.push(gitDir);
      }
    }
    const threadId = thread.id;
    const live = this.#liveThread(threadId);
    return startSession[thread.provider]({
      cwd,
      writableRoots,
      instructions: buildInstructions(project, toThread(thread), cwd),
      accessMode: thread.accessMode,
      model: thread.model,
      effort: thread.effort,
      resumeId: thread.providerSessionId,
      events: {
        sessionId: (id) => {
          this.#db.updateThread(threadId, { providerSessionId: id });
        },
        item: (item) => {
          if (item.kind === "assistant" || item.kind === "reasoning") live.streaming.set(item.id, item);
          this.#upsertItem(threadId, item);
        },
        delta: (itemId, text) => {
          const item = live.streaming.get(itemId);
          if (!item || (item.kind !== "assistant" && item.kind !== "reasoning")) return;
          live.streaming.set(itemId, { ...item, text: item.text + text });
          this.#emit({ type: "item.delta", threadId, itemId, text });
        },
        turnEnded: (outcome) => {
          for (const item of live.streaming.values()) this.#db.upsertItem(threadId, item);
          live.streaming.clear();
          this.#declineApprovals(threadId);
          if (outcome.status === "failed") this.#notice(threadId, "error", outcome.error);
          if (outcome.status === "interrupted") this.#notice(threadId, "info", "Interrupted");
          if (this.#db.getThread(threadId)) this.#setStatus(threadId, "idle");
        },
        approval: (request) =>
          new Promise<boolean>((resolve) => {
            const approval: Approval = { id: randomUUID(), ...request };
            live.approvals.set(approval.id, {
              approval,
              resolve: (allowed) => {
                live.approvals.delete(approval.id);
                this.#emit({ type: "approval.resolved", threadId, approvalId: approval.id });
                resolve(allowed);
              },
            });
            this.#emit({ type: "approval.requested", threadId, approval });
          }),
        closed: () => {
          live.session = null;
          this.#declineApprovals(threadId);
        },
      },
    });
  }

  #liveThread(threadId: string): LiveThread {
    let live = this.#live.get(threadId);
    if (!live) {
      live = { session: null, preparing: null, streaming: new Map(), approvals: new Map() };
      this.#live.set(threadId, live);
    }
    return live;
  }

  #declineApprovals(threadId: string): void {
    for (const entry of [...(this.#live.get(threadId)?.approvals.values() ?? [])]) {
      entry.resolve(false);
    }
  }

  #require(threadId: string): StoredThread {
    const thread = this.#db.getThread(threadId);
    if (!thread) throw new Error(`Unknown thread ${threadId}`);
    return thread;
  }

  #update(threadId: string, patch: Parameters<Database["updateThread"]>[1]): StoredThread {
    const thread = this.#db.updateThread(threadId, patch);
    this.#emit({ type: "thread.updated", thread: toThread(thread) });
    return thread;
  }

  #setStatus(threadId: string, status: Thread["status"]): void {
    this.#update(threadId, { status });
  }

  #upsertItem(threadId: string, item: Item): void {
    if (!this.#db.getThread(threadId)) return;
    this.#db.upsertItem(threadId, item);
    this.#emit({ type: "item.upserted", threadId, item });
  }

  #notice(threadId: string, level: "info" | "error", text: string): void {
    this.#upsertItem(threadId, { id: randomUUID(), kind: "notice", level, text });
  }
}
