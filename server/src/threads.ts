import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Approval,
  Effort,
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
import { toThread, type Database, type InboxMessage, type StoredThread } from "./db.ts";
import {
  borkcodeMessage,
  combine,
  limitReached,
  parentMessage,
  pullRequestNews,
  report,
  userMessage,
} from "./delegation.ts";
import { buildInstructions } from "./instructions.ts";
import { checkModelChoice } from "./models.ts";
import type { ProjectStore } from "./projects.ts";
import { ToolError } from "./errors.ts";
import { git } from "./exec.ts";
import {
  createPullRequest,
  describeStep,
  fastForward,
  fetchPullRequestStates,
  findPullRequest,
  linkRelated,
  mergedNotSynced,
  planPublish,
  planSync,
  pushBranch,
  rebasePastMerged,
  type PullRequestDraft,
  type PullRequestState,
} from "./pullRequests.ts";
import { startClaudeSession } from "./providers/claude.ts";
import { startCodexSession } from "./providers/codex.ts";
import {
  truncate,
  type ProviderSession,
  type SessionOptions,
  type TurnOutcome,
  type TurnSettings,
} from "./providers/types.ts";
import { DEFAULT_SETTINGS, type SettingsStore } from "./settings.ts";
import { fallbackTitle, generateTitle } from "./titles.ts";
import {
  dirtyRepos,
  ensureWorkspace,
  mainRepoPath,
  removeWorkspace,
  repoStatuses,
  scratchPath,
  runRepoSetup,
  WorkspaceDirtyError,
  workspacePath,
} from "./workspaces.ts";

const providerSessions: Record<ProviderKind, (options: SessionOptions) => Promise<ProviderSession>> = {
  claude: startClaudeSession,
  codex: startCodexSession,
};

/** What ThreadService reaches outside the process for. Tests replace these with scripted fakes. */
export interface ThreadDeps {
  startSession: (provider: ProviderKind, options: SessionOptions) => Promise<ProviderSession>;
  generateTitle: typeof generateTitle;
  pullRequestStates: typeof fetchPullRequestStates;
}

const realDeps: ThreadDeps = {
  startSession: (provider, options) => providerSessions[provider](options),
  generateTitle,
  pullRequestStates: fetchPullRequestStates,
};

/** How often open pull requests are checked for merges and closes. */
const PULL_REQUEST_POLL_MS = 60_000;

/** In-memory state for a thread whose agent may be active. */
interface LiveThread {
  session: Promise<ProviderSession> | null;
  preparing: Promise<void> | null;
  /** Streaming assistant/reasoning items of the current turn, ahead of the database. */
  streaming: Map<string, Item>;
  approvals: Map<string, { approval: Approval; resolve: (allowed: boolean) => void }>;
  /** Identifies this thread's agent session to the borkcode MCP endpoint. */
  mcpToken: string | null;
  /** A turn is being started or is running. Set synchronously, so two deliveries cannot both start one. */
  active: boolean;
  /** A steer is in flight, so its messages are not delivered twice. */
  steering: boolean;
  /** Recent automatic wake-ups, for the delegation limits. */
  wakes: number[];
  /** The user messaged the thread during the current turn; its report says so. */
  userJoined: boolean;
  /** Pull requests are being checked before a turn starts; that delivery takes what arrives meanwhile. */
  refreshing: boolean;
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
  readonly #deps: ThreadDeps;
  readonly #live = new Map<string, LiveThread>();
  readonly #mcpTokens = new Map<string, string>();
  /** Automatic wake-ups per thread tree (keyed by its root) since the user last messaged it. */
  readonly #familyWakes = new Map<string, number>();
  #pullRequestPoll: NodeJS.Timeout | null = null;

  constructor(
    db: Database,
    projects: ProjectStore,
    settings: SettingsStore,
    emit: (event: ServerEvent) => void,
    mcpBaseUrl: string,
    deps: ThreadDeps = realDeps,
  ) {
    this.#db = db;
    this.#projects = projects;
    this.#settings = settings;
    this.#emit = emit;
    this.#mcpBaseUrl = mcpBaseUrl;
    this.#deps = deps;
    this.#pollPullRequests();
  }

  list(): Thread[] {
    return this.#db.listThreads().map(toThread);
  }

  /** Starts the thread on its first message. The title is generated in the background. */
  create(params: Requests["threads.create"]["params"]): Promise<Thread> {
    return this.#start({ ...params, parentId: null, startBranch: null, watched: false });
  }

  async #start(
    params: Requests["threads.create"]["params"] & {
      parentId: string | null;
      startBranch: string | null;
      watched: boolean;
    },
  ): Promise<Thread> {
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
      parentId: params.parentId,
      startBranch: params.startBranch,
      captain: params.captain,
      watched: params.watched,
      paused: false,
      queued: 0,
      archivedAt: null,
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
        .then(() => this.#prepare(id, params.parentId ? text : null))
        .finally(() => {
          live.preparing = null;
        });
    }
    this.#db.enqueue({
      threadId: id,
      fromThreadId: params.parentId,
      kind: params.parentId && !params.watched ? "handoff" : "message",
      text,
    });
    void this.#deliver(id);
    return toThread(thread);
  }

  /**
   * Starts a thread on another thread's behalf, as a handoff. The child runs in a new worktree with
   * its parent's access mode, and its model defaults to the parent's. Returns a summary for the agent.
   */
  async startThread(
    parentId: string,
    request: {
      message: string;
      watch: boolean;
      provider?: ProviderKind;
      model?: string;
      effort?: Effort;
      startFrom: "base" | "this_branch";
    },
  ): Promise<string> {
    const parent = this.#require(parentId);
    const message = request.message.trim();
    if (!message) throw new ToolError("The new thread needs a first message.");
    const provider = request.provider ?? parent.provider;
    const inherit = provider === parent.provider && request.model === undefined;
    const choice = await checkModelChoice(
      provider,
      request.model ?? (inherit ? parent.model : null),
      request.effort ?? (inherit ? parent.effort : null),
      request.effort !== undefined,
    );

    let startBranch: string | null = null;
    if (request.startFrom === "this_branch") {
      if (!parent.workspace || !parent.branch) {
        throw new ToolError("This thread runs in the main checkouts, so it has no branch of its own to continue from. Use start_from base.");
      }
      const dirty = await dirtyRepos(await this.#projects.get(parent.project), parent.workspace);
      if (dirty.length > 0) {
        throw new ToolError(`Commit first: uncommitted changes in ${dirty.join(", ")} would not carry over to the new thread.`);
      }
      startBranch = parent.branch;
    }

    if (parent.accessMode === "ask") {
      const allowed = await this.#requestApproval(parentId, {
        title: "Start a new thread?",
        detail: [
          `${provider} · ${choice.model ?? "default model"} · ${choice.effort ?? "default"} effort`,
          `Starts from ${startBranch ?? "each repository's base branch"}`,
          "",
          truncate(message, 2000),
        ].join("\n"),
      });
      if (!allowed) throw new ToolError("The user declined. No thread was started.");
    }

    const child = await this.#start({
      project: parent.project,
      text: message,
      provider,
      model: choice.model,
      effort: choice.effort,
      accessMode: parent.accessMode,
      isolated: true,
      captain: false,
      parentId,
      startBranch,
      watched: request.watch,
    });
    this.#upsertItem(parentId, { id: randomUUID(), kind: "thread", threadId: child.id });
    return [
      `Started thread "${child.title}" (id ${child.id}) with ${provider} ${choice.model ?? "default model"},`,
      `starting from ${startBranch ?? "each repository's base branch"}. Its title is being generated from your message.`,
      request.watch
        ? "You are watching it: its final reply will come back to you as a message. Reply with send_to_thread only when it needs an answer or new instructions."
        : "It works on its own; list_child_threads shows its progress and pull requests.",
    ].join(" ");
  }

  /** A parent's request to one of its children. Delivered at the child's next step, or queued. */
  sendToThread(parentId: string, childId: string, text: string): string {
    const child = this.#db.getThread(childId);
    if (!child || child.parentId !== parentId) {
      throw new ToolError(`Thread ${childId} is not one you started. list_child_threads shows the threads you started.`);
    }
    const trimmed = text.trim();
    if (!trimmed) throw new ToolError("The message is empty.");
    this.#db.enqueue({ threadId: childId, fromThreadId: parentId, kind: "message", text: trimmed });
    this.#emitThread(childId);
    const busy = this.#liveThread(childId).active;
    void this.#deliver(childId);
    return [
      busy
        ? `"${child.title}" is busy, so your message reaches it at its next step or when its current turn ends.`
        : `Sent to "${child.title}".`,
      "Its final reply will come back to you as a message.",
    ].join(" ");
  }

  /** The threads this thread started, with what each is doing and the pull requests it opened. */
  async listChildThreads(parentId: string): Promise<string> {
    const children = this.#db.listChildren(parentId);
    if (children.length === 0) return "This thread has not started any threads.";
    const sections = await Promise.all(
      children.map(async (child) => {
        if (child.branch) await this.repoStatus(child.id).catch(() => undefined);
        const pullRequests = this.#db.listPullRequests(child.id);
        const lastReply = this.#db
          .listItems(child.id)
          .findLast((item) => item.kind === "assistant" && item.text.trim());
        return [
          `- "${child.title}" (id ${child.id}): ${child.status}${child.archivedAt ? " (archived by the user)" : ""}, ${child.provider} ${child.model ?? "default model"}, branch ${child.branch}`,
          ...pullRequests.map((pr) => `  ${pr.repo} #${pr.number} ${pr.state}: ${pr.url}`),
          lastReply && "text" in lastReply ? `  Latest reply: ${truncate(lastReply.text, 600)}` : "  No reply yet.",
        ].join("\n");
      }),
    );
    return sections.join("\n\n");
  }

  rename(threadId: string, title: string): Thread {
    this.#require(threadId);
    const trimmed = title.trim();
    if (!trimmed) throw new Error("A thread needs a title");
    return toThread(this.#update(threadId, { title: trimmed }));
  }

  /**
   * Archiving takes the subtree along, so children never surface at the top level, and is refused
   * while any of it is working. Unarchiving also restores archived ancestors, so the thread stays
   * nested under its parent. Workspaces, branches and transcripts are untouched either way.
   */
  setArchived(threadId: string, archived: boolean): void {
    const thread = this.#require(threadId);
    const subtree = this.#subtree(thread);
    if (archived) {
      const busy = subtree.find(
        (each) => each.status === "preparing" || each.status === "running" || this.#live.get(each.id)?.active,
      );
      if (busy) {
        throw new Error(`"${busy.title}" is still working. Stop it or wait for its turn to end, then archive.`);
      }
    }
    const changed = [...(archived ? [] : this.#ancestors(thread)), ...subtree].filter(
      (each) => (each.archivedAt !== null) !== archived,
    );
    this.#db.setArchived(
      changed.map((each) => each.id),
      archived ? Date.now() : null,
    );
    for (const each of changed) this.#emitThread(each.id);
  }

  /** The thread and every thread below it. */
  #subtree(thread: StoredThread): StoredThread[] {
    const found = [thread];
    for (let index = 0; index < found.length; index++) {
      for (const child of this.#db.listChildren(found[index]!.id)) {
        if (!found.some((each) => each.id === child.id)) found.push(child);
      }
    }
    return found;
  }

  #ancestors(thread: StoredThread): StoredThread[] {
    const found: StoredThread[] = [];
    for (let current = thread; current.parentId && found.length < 100; ) {
      const parent = this.#db.getThread(current.parentId);
      if (!parent) break;
      found.push(parent);
      current = parent;
    }
    return found;
  }

  async get(threadId: string): Promise<ThreadDetail> {
    const thread = this.#require(threadId);
    const project = await this.#projects.get(thread.project);
    // Someone is looking, so make sure what they see is current; changes arrive as events.
    void this.#refreshPullRequests([thread]);
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

  /**
   * A message from the user. Starts a turn when the agent is free; otherwise it joins the running
   * turn at its next step, or waits for the turn to end. Messaging a thread also resets its
   * delegation limits, since the user is now in the loop.
   */
  async send(threadId: string, text: string, settings: TurnSettings): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const thread = this.#require(threadId);
    this.#resetLimits(threadId);
    // Saved now so they apply to the next turn, even when this message joins a running one.
    if (
      settings.model !== thread.model ||
      settings.effort !== thread.effort ||
      settings.accessMode !== thread.accessMode ||
      thread.paused
    ) {
      this.#db.updateThread(threadId, { ...settings, paused: false });
    }
    this.#db.enqueue({ threadId, fromThreadId: null, kind: "message", text: trimmed });
    this.#emitThread(threadId);
    await this.#deliver(threadId);
  }

  /** Lifts a delegation pause, or delivers what waited after a stop, as if the user had messaged it. */
  async resume(threadId: string): Promise<void> {
    this.#require(threadId);
    this.#resetLimits(threadId);
    this.#db.updateThread(threadId, { paused: false });
    this.#emitThread(threadId);
    await this.#deliver(threadId);
  }

  /** Delivers messages that were waiting when the server last stopped. */
  resumeQueued(): void {
    for (const threadId of this.#db.threadsWithInbox()) void this.#deliver(threadId);
  }

  /**
   * Hands a thread's waiting messages to its agent: as a new turn when it is free, or into the
   * running turn at its next step. Messages that cannot go yet stay queued; turn ends, new
   * messages and tool calls starting all try again.
   */
  async #deliver(threadId: string): Promise<void> {
    // Called on every tool call, so skip reading settings when nothing is waiting.
    if (this.#db.listInbox(threadId).length === 0) return;
    const waiting = this.#liveThread(threadId);
    if (waiting.refreshing) return;
    const stored = this.#db.getThread(threadId);
    if (!waiting.active && stored) {
      // Before a turn starts, so a merge it finds joins this turn rather than waking the next.
      waiting.refreshing = true;
      try {
        await this.#refreshPullRequests([stored]);
      } finally {
        waiting.refreshing = false;
      }
    }
    const limits = (await this.#settings.get().catch(() => DEFAULT_SETTINGS)).delegation;
    // Everything from here to the first await runs at once, so two deliveries cannot claim the
    // same messages or start two turns.
    const thread = this.#db.getThread(threadId);
    const live = this.#liveThread(threadId);
    const messages = this.#db.listInbox(threadId);
    if (!thread || messages.length === 0 || live.steering) return;
    // Nothing works out of sight: a waiting message brings an archived thread back.
    if (thread.archivedAt !== null) this.setArchived(threadId, false);
    if (live.active && !live.session) return;
    const automatic = messages.some((message) => !fromUser(message));
    if (automatic) {
      if (thread.paused) return;
      const reason = limitReached(live.wakes, this.#familyWakes.get(this.#rootOf(thread)) ?? 0, Date.now(), limits);
      if (reason) {
        this.#db.updateThread(threadId, { paused: true });
        this.#emitThread(threadId);
        this.#notice(threadId, "info", `Paused deliveries between threads: ${reason}. Resume to deliver what is waiting.`);
        return;
      }
    }

    if (live.active) {
      live.steering = true;
      try {
        const session = await live.session!.catch(() => null);
        const steered = session ? await session.steer(this.#compose(thread, messages)) : false;
        if (!steered) return;
        this.#db.removeFromInbox(messages.map((message) => message.id));
        this.#accepted(thread, messages, true, automatic);
      } finally {
        live.steering = false;
      }
      return;
    }

    live.active = true;
    live.userJoined = false;
    this.#db.removeFromInbox(messages.map((message) => message.id));
    this.#accepted(thread, messages, false, automatic);
    await this.#runTurn(threadId, this.#compose(thread, messages));
  }

  /** Records delivered messages in the transcript. A parent's message makes it watch the thread. */
  #accepted(thread: StoredThread, messages: InboxMessage[], steered: boolean, automatic: boolean): void {
    for (const message of messages) {
      this.#upsertItem(thread.id, {
        id: randomUUID(),
        kind: "user",
        text: message.text,
        ...(message.fromThreadId ? { fromThreadId: message.fromThreadId } : {}),
        ...(message.kind === "borkcode" ? { fromBorkcode: true } : {}),
        ...(steered ? { steered: true } : {}),
      });
    }
    const live = this.#liveThread(thread.id);
    if (messages.some(fromUser)) live.userJoined = true;
    const fromParent = messages.some(
      (message) => message.kind === "message" && message.fromThreadId !== null && message.fromThreadId === thread.parentId,
    );
    if (fromParent && !thread.watched) this.#db.updateThread(thread.id, { watched: true });
    if (automatic) {
      live.wakes.push(Date.now());
      const root = this.#rootOf(thread);
      this.#familyWakes.set(root, (this.#familyWakes.get(root) ?? 0) + 1);
    }
    this.#emitThread(thread.id);
  }

  /** What the agent reads: the user's lone message as typed, anything else labelled by sender. */
  #compose(thread: StoredThread, messages: InboxMessage[]): string {
    if (messages.length === 1 && fromUser(messages[0]!)) return messages[0]!.text;
    return combine(
      messages.map((message) => {
        if (message.kind === "borkcode") return borkcodeMessage(message.text);
        if (message.fromThreadId === null) return userMessage(message.text);
        if (message.kind === "message" && message.fromThreadId === thread.parentId) {
          return parentMessage(this.#db.getThread(message.fromThreadId)?.title ?? "your parent", message.text);
        }
        return message.text;
      }),
    );
  }

  async #runTurn(threadId: string, text: string): Promise<void> {
    const live = this.#liveThread(threadId);
    await live.preparing;
    if (!this.#db.getThread(threadId)) return;
    const thread = this.#update(threadId, { status: "running" });
    try {
      // Fills in repos added to the project since the workspace was created.
      if (thread.workspace) await this.#addMissingRepos(thread);
      live.session ??= this.#openSession(thread);
      const session = await live.session;
      await session.sendTurn(text, { model: thread.model, effort: thread.effort, accessMode: thread.accessMode });
    } catch (error) {
      const session = live.session;
      live.session = null;
      void session?.then((open) => open.close(), () => undefined);
      this.#turnEnded(threadId, { status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Settles a finished turn: a watched thread reports to its parent, then anything waiting is delivered.
   * After a stop, waiting messages hold until the user sends or resumes, so stop means stop.
   */
  #turnEnded(threadId: string, outcome: TurnOutcome): void {
    const live = this.#liveThread(threadId);
    if (!live.active) return;
    live.active = false;
    const reply = [...live.streaming.values()].findLast((item) => item.kind === "assistant" && item.text.trim());
    for (const item of live.streaming.values()) this.#db.upsertItem(threadId, item);
    live.streaming.clear();
    this.#declineApprovals(threadId);
    if (!this.#db.getThread(threadId)) return;
    if (outcome.status === "failed") this.#notice(threadId, "error", outcome.error);
    if (outcome.status === "interrupted") this.#notice(threadId, "info", "Interrupted");
    const thread = this.#update(threadId, { status: "idle" });
    if (thread.watched && outcome.status !== "interrupted") {
      void this.#reportToParent(thread, outcome, reply && "text" in reply ? reply.text : null, live.userJoined);
    }
    if (outcome.status !== "interrupted") void this.#deliver(threadId);
  }

  async #reportToParent(child: StoredThread, outcome: TurnOutcome, reply: string | null, userJoined: boolean): Promise<void> {
    const parent = child.parentId ? this.#db.getThread(child.parentId) : undefined;
    if (!parent) return;
    // Picks up pull requests opened during the turn.
    if (child.branch) await this.repoStatus(child.id).catch(() => undefined);
    this.#db.enqueue({
      threadId: parent.id,
      fromThreadId: child.id,
      kind: "report",
      text: report(child, outcome, reply, this.#db.listPullRequests(child.id), userJoined),
    });
    this.#emitThread(parent.id);
    await this.#deliver(parent.id);
  }

  /** The top of a thread's tree, which the family-wide limit is counted against. */
  #rootOf(thread: StoredThread): string {
    return (this.#ancestors(thread).at(-1) ?? thread).id;
  }

  #resetLimits(threadId: string): void {
    const thread = this.#require(threadId);
    this.#liveThread(threadId).wakes = [];
    this.#familyWakes.delete(this.#rootOf(thread));
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
    else await rm(scratchPath(project, thread), { recursive: true, force: true });
    const orphans = this.#db.deleteThread(threadId);
    this.#emit({ type: "thread.deleted", threadId });
    for (const orphan of orphans) {
      const child = this.#db.getThread(orphan);
      if (child) this.#emit({ type: "thread.updated", thread: toThread(child) });
    }
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

  projectOf(threadId: string): string {
    return this.#require(threadId).project;
  }

  /** Every thread's pull requests, keyed by thread id, for clients. */
  allPullRequests(): Record<string, LinkedPullRequest[]> {
    const byThread: Record<string, LinkedPullRequest[]> = {};
    for (const { threadId, pr } of this.#db.listPullRequestLinks()) (byThread[threadId] ??= []).push(pr);
    return byThread;
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
      generated = await this.#deps.generateTitle(text, (await this.#settings.get()).titleModel);
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

  /** Creates the workspace. A handed-off thread also gets its brief saved, to re-read after compaction. */
  async #prepare(threadId: string, brief: string | null): Promise<void> {
    if (!this.#db.getThread(threadId)) return;
    try {
      const thread = this.#require(threadId);
      await this.#addMissingRepos(thread);
      if (brief) {
        const scratch = scratchPath(await this.#projects.get(thread.project), thread);
        await mkdir(scratch, { recursive: true });
        await writeFile(join(scratch, "brief.md"), `${brief}\n`);
      }
      this.#setStatus(threadId, "idle");
    } catch (error) {
      this.#notice(threadId, "error", `Could not create the workspace: ${error instanceof Error ? error.message : String(error)}`);
      this.#setStatus(threadId, "error");
    }
  }

  async #addMissingRepos(thread: StoredThread): Promise<void> {
    if (!thread.workspace || !thread.branch) return;
    const project = await this.#projects.get(thread.project);
    const created = await ensureWorkspace(project, thread.workspace, thread.branch, thread.startBranch);
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
    const scratch = scratchPath(project, thread);
    await mkdir(scratch, { recursive: true });
    if (!thread.workspace) writableRoots.push(scratch);
    const brief = join(scratch, "brief.md");
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
    return this.#deps.startSession(thread.provider, {
      cwd,
      writableRoots,
      instructions: buildInstructions(project, toThread(thread), cwd, settings, {
        scratch,
        parent: thread.parentId ? (this.#db.getThread(thread.parentId) ?? null) : null,
        brief: thread.parentId && existsSync(brief) ? brief : null,
      }),
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
          // A tool call starting is a moment a waiting message can join the turn.
          if (item.kind === "tool" && item.status === "running") void this.#deliver(threadId);
        },
        delta: (itemId, text) => {
          const item = live.streaming.get(itemId);
          if (!item || (item.kind !== "assistant" && item.kind !== "reasoning")) return;
          live.streaming.set(itemId, { ...item, text: item.text + text });
          this.#emit({ type: "item.delta", threadId, itemId, text });
        },
        turnEnded: (outcome) => this.#turnEnded(threadId, outcome),
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
      live = {
        session: null,
        preparing: null,
        streaming: new Map(),
        approvals: new Map(),
        mcpToken: null,
        active: false,
        steering: false,
        wakes: [],
        userJoined: false,
        refreshing: false,
      };
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

  /**
   * Links or refreshes pull requests. One that was linked before and is now merged or closed wakes
   * the thread, which reports to its parent if watched; the inbox keeps the news across restarts.
   */
  #linkPullRequests(threadId: string, pullRequests: LinkedPullRequest[]): void {
    if (!this.#db.getThread(threadId)) return;
    const before = new Map(this.#db.listPullRequests(threadId).map((pr) => [pr.url, pr.state]));
    const changed = pullRequests.filter((pr) => this.#db.linkPullRequest(threadId, pr)).length > 0;
    if (changed) {
      this.#emit({ type: "pullRequests.changed", threadId, pullRequests: this.#db.listPullRequests(threadId) });
    }
    const ended = pullRequests.filter(
      (pr) => before.has(pr.url) && before.get(pr.url) !== pr.state && (pr.state === "MERGED" || pr.state === "CLOSED"),
    );
    if (ended.length > 0) {
      this.#db.enqueue({ threadId, fromThreadId: null, kind: "borkcode", text: pullRequestNews(ended) });
      this.#emitThread(threadId);
      void this.#deliver(threadId);
    }
    if (pullRequests.some((pr) => pr.state === "OPEN")) this.#pollPullRequests();
  }

  /**
   * Checks open pull requests for merges and closes every minute, while any are open. GitHub
   * webhooks would need a public endpoint, which a local server does not have.
   */
  #pollPullRequests(): void {
    if (this.#pullRequestPoll || this.#db.listPullRequestLinks("OPEN").length === 0) return;
    this.#pullRequestPoll = setTimeout(async () => {
      try {
        await this.refreshOpenPullRequests();
      } catch (error) {
        console.error(error);
      } finally {
        // One failed poll must not stop polling until the next restart.
        this.#pullRequestPoll = null;
        this.#pollPullRequests();
      }
    }, PULL_REQUEST_POLL_MS);
    this.#pullRequestPoll.unref();
  }

  /** One poll: every open pull request of every thread. */
  async refreshOpenPullRequests(): Promise<void> {
    await this.#refreshLinks(this.#db.listPullRequestLinks("OPEN"));
  }

  /** Re-checks the threads' open pull requests. Merged and closed ones stay as they are. */
  #refreshPullRequests(threads: StoredThread[]): Promise<void> {
    return this.#refreshLinks(
      threads.flatMap((thread) =>
        this.#db
          .listPullRequests(thread.id)
          .filter((pr) => pr.state === "OPEN")
          .map((pr) => ({ threadId: thread.id, pr })),
      ),
    );
  }

  async #refreshLinks(links: { threadId: string; pr: LinkedPullRequest }[]): Promise<void> {
    if (links.length === 0) return;
    const states = await this.#deps.pullRequestStates([...new Set(links.map((link) => link.pr.url))]).catch(
      () => new Map<string, PullRequestState>(),
    );
    const updated = new Map<string, LinkedPullRequest[]>();
    for (const { threadId, pr } of links) {
      const state = states.get(pr.url);
      if (state) updated.set(threadId, [...(updated.get(threadId) ?? []), { ...pr, ...state }]);
    }
    for (const [threadId, pullRequests] of updated) this.#linkPullRequests(threadId, pullRequests);
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

  /** Broadcasts a thread after a change made directly in the database, such as its queue. */
  #emitThread(threadId: string): void {
    const thread = this.#db.getThread(threadId);
    if (thread) this.#emit({ type: "thread.updated", thread: toThread(thread) });
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

/** Typed by the user, as opposed to sent by another thread or by borkcode. */
function fromUser(message: InboxMessage): boolean {
  return message.fromThreadId === null && message.kind !== "borkcode";
}
