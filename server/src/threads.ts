import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  Approval,
  Item,
  LinkedPullRequest,
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
import { git } from "./exec.ts";
import {
  createPullRequest,
  describeStep,
  fastForward,
  findPullRequest,
  linkRelated,
  mergedNotSynced,
  planPublish,
  planSync,
  pushBranch,
  rebasePastMerged,
  ToolError,
  type PullRequestDraft,
} from "./pullRequests.ts";
import { startClaudeSession } from "./providers/claude.ts";
import { startCodexSession } from "./providers/codex.ts";
import type { ProviderSession, SessionOptions, TurnSettings } from "./providers/types.ts";
import { DEFAULT_SETTINGS, type SettingsStore } from "./settings.ts";
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
  /** Identifies this thread's agent session to the borkcode MCP endpoint. */
  mcpToken: string | null;
}

const PUBLISH_MESSAGE = [
  "Commit any work that is still uncommitted, then push and open pull requests with the borkcode open_pull_requests tool.",
  "Write each title and description from the commits: what changed, why, and how it was tested.",
  "Finish by listing the pull request URLs.",
].join(" ");

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
  /** Agent sessions reach the MCP endpoint at this URL followed by their token. */
  readonly #mcpBaseUrl: string;
  readonly #live = new Map<string, LiveThread>();
  readonly #mcpTokens = new Map<string, string>();

  constructor(
    db: Database,
    projects: ProjectStore,
    settings: SettingsStore,
    emit: (event: ServerEvent) => void,
    mcpBaseUrl: string,
  ) {
    this.#db = db;
    this.#projects = projects;
    this.#settings = settings;
    this.#emit = emit;
    this.#mcpBaseUrl = mcpBaseUrl;
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
      pullRequests: this.#db.listPullRequests(threadId),
    };
  }

  /**
   * Sends the agent the standard request to commit, push and open pull requests. Throws right away,
   * rather than from the returned turn, when the thread cannot publish.
   */
  publish(threadId: string, settings: TurnSettings): Promise<void> {
    if (!this.#require(threadId).workspace) {
      throw new Error("Threads in the main checkouts cannot publish; their branches are the base branches");
    }
    return this.send(threadId, PUBLISH_MESSAGE, settings);
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
    if (live?.mcpToken) this.#mcpTokens.delete(live.mcpToken);
    if (live?.session) (await live.session.catch(() => null))?.close();
    this.#live.delete(threadId);
    if (thread.workspace) await removeWorkspace(project, thread.workspace, true);
    this.#db.deleteThread(threadId);
    this.#emit({ type: "thread.deleted", threadId });
  }

  /** Also links any pull request found on the thread's branch, so PRs opened by hand show up. */
  async repoStatus(threadId: string): Promise<RepoStatus[]> {
    const thread = this.#require(threadId);
    const statuses = await repoStatuses(await this.#projects.get(thread.project), thread.workspace);
    const branch = thread.branch;
    if (branch) {
      const found = await Promise.all(
        statuses.filter((status) => status.exists).map((status) => findPullRequest(status.name, status.path, branch)),
      );
      this.#linkPullRequests(threadId, found.filter((pr) => pr !== null));
    }
    return statuses;
  }

  threadForMcpToken(token: string): string | undefined {
    return this.#mcpTokens.get(token);
  }

  async listPullRequests(threadId: string): Promise<LinkedPullRequest[]> {
    await this.repoStatus(threadId);
    return this.#db.listPullRequests(threadId);
  }

  /**
   * Pushes the thread's branch and opens or updates one pull request per repository with commits
   * ahead, then links the pull requests to each other. Returns a summary for the agent.
   */
  async openPullRequests(threadId: string, drafts: PullRequestDraft[]): Promise<string> {
    const thread = this.#require(threadId);
    const branch = thread.branch;
    if (!branch) throw new ToolError("This thread works in the main checkouts, so it has no branch of its own to publish.");
    const statuses = await this.repoStatus(threadId);
    const linked = this.#db.listPullRequests(threadId);
    const steps = planPublish(statuses, drafts, linked, await mergedNotSynced(statuses, linked));
    if (steps.length === 0) return "Nothing to publish: no repository has commits ahead of its base branch.";
    const plan = steps.map((step) => describeStep(step, branch)).join("\n");
    if (thread.accessMode === "ask") {
      const allowed = await this.#requestApproval(threadId, { title: "Push and open pull requests?", detail: plan });
      if (!allowed) throw new ToolError("The user declined. Nothing was pushed.");
    }

    const results: string[] = [];
    let failed = false;
    for (const step of steps) {
      try {
        await pushBranch(step.path, branch, step.lease);
        if (step.action === "open") {
          const pr = await createPullRequest(step.path, { ...step, branch });
          this.#linkPullRequests(threadId, [pr]);
          results.push(`${step.repo}: opened ${pr.url}`);
        } else {
          results.push(`${step.repo}: pushed to ${step.pullRequest.url}`);
        }
      } catch (error) {
        failed = true;
        results.push(`${step.repo}: failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const open = this.#db.listPullRequests(threadId).filter((pr) => pr.state === "OPEN");
    const paths = new Map(statuses.map((status) => [status.name, status.path]));
    for (const pr of open) {
      const path = paths.get(pr.repo);
      if (!path) continue;
      await linkRelated(path, pr, open.filter((other) => other !== pr)).catch((error: Error) => {
        failed = true;
        results.push(`${pr.repo}: could not link related pull requests: ${error.message}`);
      });
    }
    const summary = results.join("\n");
    if (failed) throw new ToolError(summary);
    return summary;
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
    if (live.mcpToken) this.#mcpTokens.delete(live.mcpToken);
    const mcpToken = randomUUID();
    live.mcpToken = mcpToken;
    this.#mcpTokens.set(mcpToken, threadId);
    // A typo in the hand-editable file should not stop agents from starting.
    const settings = await this.#settings.get().catch((error: Error) => {
      this.#notice(threadId, "error", `${error.message}. Using default settings.`);
      return DEFAULT_SETTINGS;
    });
    return startSession[thread.provider]({
      cwd,
      writableRoots,
      instructions: buildInstructions(project, toThread(thread), cwd, settings),
      accessMode: thread.accessMode,
      model: thread.model,
      effort: thread.effort,
      mcpUrl: `${this.#mcpBaseUrl}${mcpToken}`,
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
        approval: (request) => this.#requestApproval(threadId, request),
        closed: () => {
          live.session = null;
          if (live.mcpToken === mcpToken) {
            this.#mcpTokens.delete(mcpToken);
            live.mcpToken = null;
          }
          this.#declineApprovals(threadId);
        },
      },
    });
  }

  #liveThread(threadId: string): LiveThread {
    let live = this.#live.get(threadId);
    if (!live) {
      live = { session: null, preparing: null, streaming: new Map(), approvals: new Map(), mcpToken: null };
      this.#live.set(threadId, live);
    }
    return live;
  }

  /**
   * Brings the thread's branch up to date with the latest base branches: past merged pull requests,
   * and fast-forwarded where nothing is ahead. Local only, so it needs no approval.
   */
  async syncWithBase(threadId: string): Promise<string> {
    const thread = this.#require(threadId);
    if (!thread.workspace) throw new ToolError("This thread works in the main checkouts, so it has no branch of its own to sync.");
    const statusesBefore = await repoStatuses(await this.#projects.get(thread.project), thread.workspace);
    await Promise.all(
      statusesBefore
        .filter((status) => status.exists)
        .map((status) =>
          git(status.path, "fetch", "--quiet", "origin").catch((error: Error) => {
            throw new ToolError(`Could not fetch ${status.name}: ${error.message}`);
          }),
        ),
    );
    const statuses = await this.repoStatus(threadId);
    const steps = planSync(statuses, await mergedNotSynced(statuses, this.#db.listPullRequests(threadId)));

    const results: string[] = [];
    let failed = false;
    for (const step of steps) {
      if (step.action === "keep") {
        results.push(`${step.repo}: left as is (${step.reason})`);
      } else if (step.action === "fast-forward") {
        await fastForward(step.path, step.base);
        results.push(`${step.repo}: fast-forwarded to origin/${step.base}`);
      } else {
        const conflicts = await rebasePastMerged(step.path, step.base, step.merged.headOid);
        if (conflicts.length > 0) {
          failed = true;
          results.push(
            `${step.repo}: replaying the commits made after #${step.merged.number} onto origin/${step.base} conflicts in:\n${conflicts.join("\n")}\nNothing was changed in ${step.repo}.`,
          );
        } else {
          results.push(`${step.repo}: moved past merged #${step.merged.number} onto origin/${step.base}, keeping later commits`);
        }
      }
    }
    const summary = results.join("\n");
    if (failed) throw new ToolError(summary);
    return summary;
  }

  #requestApproval(threadId: string, request: Omit<Approval, "id">): Promise<boolean> {
    const live = this.#liveThread(threadId);
    return new Promise<boolean>((resolve) => {
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
    });
  }

  #linkPullRequests(threadId: string, pullRequests: LinkedPullRequest[]): void {
    if (!this.#db.getThread(threadId)) return;
    const changed = pullRequests.filter((pr) => this.#db.linkPullRequest(threadId, pr)).length > 0;
    if (changed) {
      this.#emit({ type: "pullRequests.changed", threadId, pullRequests: this.#db.listPullRequests(threadId) });
    }
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
