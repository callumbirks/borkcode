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
  createdAt: number;
  updatedAt: number;
}

export type ToolStatus = "running" | "done" | "failed";

export type Item =
  | { id: string; kind: "user"; text: string }
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
  | { id: string; kind: "notice"; level: "info" | "error"; text: string };

export interface Approval {
  id: string;
  title: string;
  detail: string;
}

export interface PullRequestRef {
  number: number;
  url: string;
  state: string;
  title: string;
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
  pullRequest: PullRequestRef | null;
}

export interface ThreadDetail {
  thread: Thread;
  workspacePath: string;
  items: Item[];
  approvals: Approval[];
}

export interface Requests {
  "projects.list": { params: Record<string, never>; result: Project[] };
  "projects.create": { params: { name: string }; result: Project };
  "repos.add": { params: { project: string; url: string; name?: string }; result: Project };
  "repos.update": {
    params: { project: string; name: string; baseBranch?: string; setup?: string };
    result: Project;
  };
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
    };
    result: Thread;
  };
  "threads.get": { params: { threadId: string }; result: ThreadDetail };
  /** Model and effort apply to this turn and are remembered for the next. */
  "threads.send": {
    params: { threadId: string; text: string; model: string | null; effort: Effort | null };
    result: null;
  };
  /** Changes only the displayed title; the workspace and branch keep their names. */
  "threads.rename": { params: { threadId: string; title: string }; result: Thread };
  "threads.interrupt": { params: { threadId: string }; result: null };
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
  | { type: "thread.updated"; thread: Thread }
  | { type: "thread.deleted"; threadId: string }
  | { type: "item.upserted"; threadId: string; item: Item }
  | { type: "item.delta"; threadId: string; itemId: string; text: string }
  | { type: "approval.requested"; threadId: string; approval: Approval }
  | { type: "approval.resolved"; threadId: string; approvalId: string };

export type ClientMessage = { id: number; method: RequestMethod; params: unknown };

export type ServerMessage =
  | { id: number; result: unknown }
  | { id: number; error: { message: string } }
  | { event: ServerEvent };
