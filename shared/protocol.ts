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
  /** Pick a child thread's model from its parent's. The first match applies; none means copy the parent. */
  childModelRules: ChildModelRule[];
}

/**
 * Matches a parent on its provider and model, and on its effort unless that is null (any effort).
 * A parent on the provider's default model or effort matches the default's name.
 */
export interface ChildModelRule {
  when: { provider: ProviderKind; model: string; effort: Effort | null };
  use: ModelChoice;
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
  /**
   * When the user tucked the thread away, with its subtree; null when it is not archived. Archived
   * threads keep everything and are listed only on the Archived page. A message unarchives them.
   */
  archivedAt: number | null;
  /**
   * When a turn last ended with something for the user, null if none has. A watched child's turn
   * the user did not join only reports to its parent, and stopped turns are not responses.
   */
  respondedAt: number | null;
  /** When the user last read the thread. It is unread while `respondedAt` is later. */
  readAt: number | null;
  /** The agent is blocked on the user: an approval or a question is pending. */
  waiting: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * A file the user uploaded to a thread to send with a message. The browser uploads the bytes with
 * `POST /api/threads/<threadId>/attachments` (the raw file as the body, its type as `content-type`
 * and its URI-encoded name as `x-filename`), which answers with this record, and shows them from
 * `GET /api/threads/<threadId>/attachments/<id>`. Only images are accepted for now.
 */
export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  /** In bytes. */
  size: number;
}

export type ToolStatus = "running" | "done" | "failed";

export type Item =
  | {
      id: string;
      kind: "user";
      text: string;
      /** Files sent with the message. Absent when there are none. */
      attachments?: Attachment[];
      /** Set when another thread's agent sent this message: a handoff, a request or a report. */
      fromThreadId?: string;
      /** Sent by borkcode itself, such as news that a pull request was merged. */
      fromBorkcode?: boolean;
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
  | { id: string; kind: "thread"; threadId: string }
  /**
   * The agent asked the user. Answers line up with `questions`, and stay null while the question is
   * pending or if it was dropped unanswered because the turn stopped.
   */
  | { id: string; kind: "question"; questions: Question[]; answers: string[][] | null };

/** A question the agent asks the user, with options to pick from. A typed answer is always allowed. */
export interface Question {
  /** A short label, such as "Next step". */
  header: string;
  question: string;
  /** Empty when only a typed answer makes sense. */
  options: { label: string; description: string }[];
  /** More than one option may be picked. */
  multiSelect: boolean;
}

/** Questions the agent is waiting on, asked together and answered together. Shares its id with its item. */
export interface QuestionRequest {
  id: string;
  questions: Question[];
}

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
  questions: QuestionRequest[];
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
  /** Deletes a folder and everything in it. Returns how many files were removed. */
  "files.deleteFolder": { params: { project: string; path: string }; result: number };
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
  /**
   * Model, effort and access mode apply to this turn and are remembered for the next. Attachments
   * are ids of files uploaded to this thread; with any, the text may be empty.
   */
  "threads.send": {
    params: {
      threadId: string;
      text: string;
      attachments?: string[];
      model: string | null;
      effort: Effort | null;
      accessMode: AccessMode;
    };
    result: null;
  };
  /** Asks the agent to commit, push and open pull requests through its borkcode tool. */
  "threads.publish": {
    params: { threadId: string; model: string | null; effort: Effort | null; accessMode: AccessMode };
    result: null;
  };
  /** Changes only the displayed title; the workspace and branch keep their names. */
  "threads.rename": { params: { threadId: string; title: string }; result: Thread };
  "threads.interrupt": { params: { threadId: string }; result: null };
  /** Lifts a delegation pause and delivers what is queued. */
  "threads.resume": { params: { threadId: string }; result: null };
  /**
   * Archiving takes the thread's subtree with it and is refused while any of it is running.
   * Unarchiving restores the subtree and any archived ancestors, so the thread stays nested.
   */
  "threads.archive": { params: { threadId: string; archived: boolean }; result: null };
  /** Sent once the user has had the thread open and visible for a few seconds. Not activity. */
  "threads.markRead": { params: { threadId: string }; result: null };
  "threads.delete": { params: { threadId: string; force?: boolean }; result: null };
  "threads.repoStatus": { params: { threadId: string }; result: RepoStatus[] };
  /** Every thread's linked pull requests, keyed by thread id. `pullRequests.changed` keeps them current. */
  "pullRequests.list": { params: Record<string, never>; result: Record<string, LinkedPullRequest[]> };
  /**
   * Checks open pull requests now, as a poll would; sent when the user comes back to borkcode.
   * Skipped if a check ran in the last few seconds. Changes arrive as `pullRequests.changed`.
   */
  "pullRequests.refresh": { params: Record<string, never>; result: null };
  "approvals.respond": {
    params: { threadId: string; approvalId: string; allow: boolean };
    result: null;
  };
  /**
   * One answer per question: the picked option labels, plus any typed answer. The agent gets
   * them as the result of its question tool.
   */
  "questions.answer": {
    params: { threadId: string; questionId: string; answers: string[][] };
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
  | { type: "question.requested"; threadId: string; question: QuestionRequest }
  | { type: "question.resolved"; threadId: string; questionId: string }
  | { type: "pullRequests.changed"; threadId: string; pullRequests: LinkedPullRequest[] };

export type ClientMessage = { id: number; method: RequestMethod; params: unknown };

export type ServerMessage =
  | { id: number; result: unknown }
  | { id: number; error: { message: string } }
  | { event: ServerEvent };
