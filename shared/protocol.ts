// Wire types shared by the server and the web client.

export type ProviderKind = "claude" | "codex";

/** "ask" routes risky actions to the user; "full" lets the agent act without prompts. */
export type AccessMode = "ask" | "full";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** A model as listed by its provider's CLI. */
export interface ModelOption {
  /** Passed back to the provider as the model name. */
  id: string;
  name: string;
  /** Picked by the provider when no model is chosen. */
  isDefault: boolean;
  /** Empty when the model has no effort control. */
  efforts: Effort[];
  /** Null when the provider does not say which level it uses by default. */
  defaultEffort: Effort | null;
}

/** Null model or effort means the provider's default. */
export interface ModelChoice {
  provider: ProviderKind;
  model: string | null;
  effort: Effort | null;
}

/** Stored in `<home>/settings.json`, safe to hand-edit. */
export interface Settings {
  /** Model that names new threads from their first message. */
  titleModel: ModelChoice;
  /** Agents in worktree threads commit finished steps without being asked. */
  autoCommit: boolean;
  delegation: DelegationLimits;
}

/**
 * Stops threads from waking each other forever. Messages between threads that would exceed a
 * limit stay queued, and the thread pauses until the user resumes it or messages it.
 */
export interface DelegationLimits {
  /** Automatic wake-ups one thread may get within `windowMinutes`; catches fast loops. */
  wakesPerWindow: number;
  windowMinutes: number;
  /** Automatic wake-ups across a captain and its children since the user last messaged any of them. */
  maxAutomaticTurns: number;
}

export interface RepoConfig {
  /** Directory name inside repos/ and every workspace. Sibling tooling may depend on it. */
  name: string;
  url: string;
  baseBranch: string;
  /** Shell command run inside each new worktree of this repo. */
  setup?: string;
}

export interface Project {
  name: string;
  path: string;
  repos: RepoConfig[];
}

/** A file in a project's shared `files/` folder, which every thread and the user can read and write. */
export interface ProjectFile {
  /** Relative to the files folder, with forward slashes. */
  path: string;
  size: number;
  modifiedAt: number;
}

export type ThreadStatus = "preparing" | "idle" | "running" | "error";

export interface Thread {
  id: string;
  project: string;
  title: string;
  provider: ProviderKind;
  /** Used for the next turn; null means the provider's default. */
  model: string | null;
  effort: Effort | null;
  accessMode: AccessMode;
  /** Folder name under worktrees/, or null when the thread runs in the main checkouts in repos/. */
  workspace: string | null;
  /** Branch shared by every worktree in the workspace. Null for main checkouts. */
  branch: string | null;
  status: ThreadStatus;
  /** The thread whose agent started this one, if any. */
  parentId: string | null;
  /** Coordinates work across the threads it starts; gets captain instructions. */
  captain: boolean;
  /** Its parent keeps track of it: the final reply of each of its turns goes to the parent. */
  watched: boolean;
  /** Messages waiting for the agent: from the user, its parent or its children. */
  queued: number;
  /** Deliveries between threads hit a delegation limit; queued messages wait for the user. */
  paused: boolean;
  createdAt: number;
  updatedAt: number;
}

export type ToolStatus = "running" | "done" | "failed";

export type Item =
  | {
      id: string;
      kind: "user";
      text: string;
      /** Set when another thread's agent sent this message: a handoff, a request or a report. */
      fromThreadId?: string;
      /** Delivered into a turn that was already running, at its next step. */
      steered?: boolean;
    }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "reasoning"; text: string }
  | {
      id: string;
      kind: "tool";
      name: string;
      summary: string;
      output: string | null;
      status: ToolStatus;
    }
  | { id: string; kind: "notice"; level: "info" | "error"; text: string }
  /** This thread's agent started another thread. */
  | { id: string; kind: "thread"; threadId: string };

export interface Approval {
  id: string;
  title: string;
  detail: string;
}

/** A pull request linked to a thread: opened by its tool, or found on its branch. */
export interface LinkedPullRequest {
  repo: string;
  number: number;
  url: string;
  /** As GitHub reports it: OPEN, MERGED or CLOSED. */
  state: string;
  title: string;
  /** The PR's head commit. Once merged, syncing replays only the commits after it. */
  headOid: string;
}

export interface RepoStatus {
  name: string;
  path: string;
  exists: boolean;
  branch: string | null;
  baseBranch: string;
  changedFiles: string[];
  /** Commits on the branch that are not on the base branch. */
  ahead: number | null;
}

export interface ThreadDetail {
  thread: Thread;
  workspacePath: string;
  items: Item[];
  approvals: Approval[];
  pullRequests: LinkedPullRequest[];
}

export interface Requests {
  "projects.list": { params: Record<string, never>; result: Project[] };
  "projects.create": { params: { name: string }; result: Project };
  "repos.add": { params: { project: string; url: string; name?: string }; result: Project };
  "repos.update": {
    params: { project: string; name: string; baseBranch?: string; setup?: string };
    result: Project;
  };
  "files.list": { params: { project: string }; result: ProjectFile[] };
  "files.read": { params: { project: string; path: string }; result: { content: string; modifiedAt: number } };
  /**
   * Fails if the file changed since `expectedModifiedAt`, so an agent's edit is never silently
   * overwritten. Null expects the file not to exist yet.
   */
  "files.write": {
    params: { project: string; path: string; content: string; expectedModifiedAt: number | null };
    result: ProjectFile;
  };
  "files.delete": { params: { project: string; path: string }; result: null };
  "threads.list": { params: Record<string, never>; result: Thread[] };
  "threads.create": {
    params: {
      project: string;
      /** First message to the agent. The thread's title is generated from it. */
      text: string;
      provider: ProviderKind;
      model: string | null;
      effort: Effort | null;
      accessMode: AccessMode;
      /** False runs the thread directly in the main checkouts. */
      isolated: boolean;
      captain: boolean;
    };
    result: Thread;
  };
  "threads.get": { params: { threadId: string }; result: ThreadDetail };
  /** Model and effort apply to this turn and are remembered for the next. */
  "threads.send": {
    params: { threadId: string; text: string; model: string | null; effort: Effort | null };
    result: null;
  };
  /** Asks the agent to commit, push and open pull requests through its borkcode tool. */
  "threads.publish": {
    params: { threadId: string; model: string | null; effort: Effort | null };
    result: null;
  };
  /** Changes only the displayed title; the workspace and branch keep their names. */
  "threads.rename": { params: { threadId: string; title: string }; result: Thread };
  "threads.interrupt": { params: { threadId: string }; result: null };
  /** Lifts a delegation pause and delivers what is queued. */
  "threads.resume": { params: { threadId: string }; result: null };
  "threads.delete": { params: { threadId: string; force?: boolean }; result: null };
  "threads.repoStatus": { params: { threadId: string }; result: RepoStatus[] };
  "approvals.respond": {
    params: { threadId: string; approvalId: string; allow: boolean };
    result: null;
  };
  "models.list": { params: { provider: ProviderKind }; result: ModelOption[] };
  "settings.get": { params: Record<string, never>; result: Settings };
  "settings.update": { params: { settings: Settings }; result: Settings };
}

export type RequestMethod = keyof Requests;

export type ServerEvent =
  | { type: "projects.changed"; projects: Project[] }
  | { type: "settings.changed"; settings: Settings }
  /** Sent whenever anything in the folder changes, whether through borkcode or not. */
  | { type: "files.changed"; project: string; files: ProjectFile[] }
  | { type: "thread.updated"; thread: Thread }
  | { type: "thread.deleted"; threadId: string }
  | { type: "item.upserted"; threadId: string; item: Item }
  | { type: "item.delta"; threadId: string; itemId: string; text: string }
  | { type: "approval.requested"; threadId: string; approval: Approval }
  | { type: "approval.resolved"; threadId: string; approvalId: string }
  | { type: "pullRequests.changed"; threadId: string; pullRequests: LinkedPullRequest[] };

export type ClientMessage = { id: number; method: RequestMethod; params: unknown };

export type ServerMessage =
  | { id: number; result: unknown }
  | { id: number; error: { message: string } }
  | { event: ServerEvent };
