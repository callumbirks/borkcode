import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AccessMode,
  Approval,
  Item,
  Project,
  ProviderKind,
  RepoConfig,
  RepoStatus,
  ServerEvent,
  Thread,
  ThreadDetail,
} from "shared/protocol";
import { toThread, type Database, type StoredThread } from "./db.ts";
import { buildInstructions } from "./instructions.ts";
import type { ProjectStore } from "./projects.ts";
import { startClaudeSession } from "./providers/claude.ts";
import { startCodexSession } from "./providers/codex.ts";
import type { ProviderSession, SessionOptions } from "./providers/types.ts";
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
  readonly #emit: (event: ServerEvent) => void;
  readonly #live = new Map<string, LiveThread>();

  constructor(db: Database, projects: ProjectStore, emit: (event: ServerEvent) => void) {
    this.#db = db;
    this.#projects = projects;
    this.#emit = emit;
  }

  list(): Thread[] {
    return this.#db.listThreads().map(toThread);
  }

  async create(params: {
    project: string;
    title: string;
    provider: ProviderKind;
    accessMode: AccessMode;
    isolated: boolean;
    model?: string;
  }): Promise<Thread> {
    const project = await this.#projects.get(params.project);
    const title = params.title.trim();
    if (!title) throw new Error("A thread needs a title");
    const id = randomUUID();
    const workspace = params.isolated ? workspaceSlug(title, id) : null;
    const now = Date.now();
    const thread: StoredThread = {
      id,
      project: project.name,
      title,
      provider: params.provider,
      model: params.model?.trim() || null,
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
    if (workspace) {
      const live = this.#liveThread(id);
      live.preparing = this.#prepare(thread).finally(() => {
        live.preparing = null;
      });
    }
    return toThread(thread);
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

  async send(threadId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    let thread = this.#require(threadId);
    if (thread.status === "running") throw new Error("The agent is still working on the last message");
    const live = this.#liveThread(threadId);
    await live.preparing;
    thread = this.#require(threadId);

    this.#upsertItem(threadId, { id: randomUUID(), kind: "user", text: trimmed });
    this.#setStatus(threadId, "running");
    try {
      // Fills in repos added to the project since the workspace was created.
      if (thread.workspace) await this.#addMissingRepos(thread);
      live.session ??= this.#openSession(thread);
      const session = await live.session;
      await session.sendTurn(trimmed);
    } catch (error) {
      live.session = null;
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

  async #prepare(thread: StoredThread): Promise<void> {
    try {
      await this.#addMissingRepos(thread);
      this.#setStatus(thread.id, "idle");
    } catch (error) {
      this.#notice(thread.id, "error", `Could not create the workspace: ${error instanceof Error ? error.message : String(error)}`);
      this.#setStatus(thread.id, "error");
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

  #setStatus(threadId: string, status: Thread["status"]): void {
    const thread = this.#db.updateThread(threadId, { status });
    this.#emit({ type: "thread.updated", thread: toThread(thread) });
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
