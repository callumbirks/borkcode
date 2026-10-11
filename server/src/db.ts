import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Item, LinkedPullRequest, Thread } from "shared/protocol";

export interface StoredThread extends Thread {
  /** Provider-native session or thread id, used to resume after a restart. */
  providerSessionId: string | null;
  /** Branch the workspace starts from instead of each repo's base, for handoffs that continue work. */
  startBranch: string | null;
}

/** A message waiting for a thread's agent, delivered when it can take it. */
export interface InboxMessage {
  id: string;
  threadId: string;
  /** The thread whose agent sent it, or null for the user. */
  fromThreadId: string | null;
  /**
   * message: from the user, or from the parent, which then watches the thread.
   * handoff: a parent's brief for a thread it does not watch. report: a child's final reply.
   * borkcode: news from borkcode itself, such as a pull request being merged; it has no sender.
   */
  kind: "message" | "handoff" | "report" | "borkcode";
  text: string;
  createdAt: number;
}

/** Threads with the number of messages waiting for each. */
const SELECT_THREADS = `SELECT threads.*, (SELECT COUNT(*) FROM inbox WHERE inbox.thread_id = threads.id) AS queued FROM threads`;

interface ThreadRow {
  id: string;
  project: string;
  title: string;
  provider: Thread["provider"];
  model: string | null;
  effort: Thread["effort"];
  access_mode: Thread["accessMode"];
  workspace: string | null;
  branch: string | null;
  status: Thread["status"];
  provider_session_id: string | null;
  parent_id: string | null;
  start_branch: string | null;
  captain: number;
  watched: number;
  paused: number;
  queued: number;
  archived_at: number | null;
  responded_at: number | null;
  read_at: number | null;
  created_at: number;
  updated_at: number;
}

function fromRow(row: ThreadRow): StoredThread {
  return {
    id: row.id,
    project: row.project,
    title: row.title,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    accessMode: row.access_mode,
    workspace: row.workspace,
    branch: row.branch,
    status: row.status,
    providerSessionId: row.provider_session_id,
    parentId: row.parent_id,
    startBranch: row.start_branch,
    captain: row.captain === 1,
    watched: row.watched === 1,
    paused: row.paused === 1,
    queued: row.queued,
    archivedAt: row.archived_at,
    respondedAt: row.responded_at,
    readAt: row.read_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toThread({ providerSessionId: _, startBranch: __, ...thread }: StoredThread): Thread {
  return thread;
}

export class Database {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        title TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        access_mode TEXT NOT NULL,
        workspace TEXT,
        branch TEXT,
        status TEXT NOT NULL,
        provider_session_id TEXT,
        parent_id TEXT,
        start_branch TEXT,
        captain INTEGER NOT NULL DEFAULT 0,
        watched INTEGER NOT NULL DEFAULT 0,
        paused INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        responded_at INTEGER,
        read_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbox (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        from_thread_id TEXT,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS items (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (thread_id, id)
      );
      CREATE INDEX IF NOT EXISTS items_by_seq ON items (thread_id, seq);
      CREATE TABLE IF NOT EXISTS pull_requests (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        state TEXT NOT NULL,
        title TEXT NOT NULL,
        head_oid TEXT NOT NULL DEFAULT '',
        linked_at INTEGER NOT NULL,
        PRIMARY KEY (thread_id, url)
      );
      PRAGMA foreign_keys = ON;
    `);
    const columns = this.#db.prepare(`PRAGMA table_info(threads)`).all() as unknown as { name: string }[];
    const missing = (column: string) => !columns.some((existing) => existing.name === column);
    for (const column of ["effort", "parent_id", "start_branch"]) {
      if (missing(column)) this.#db.exec(`ALTER TABLE threads ADD COLUMN ${column} TEXT`);
    }
    for (const column of ["captain", "watched", "paused"]) {
      if (missing(column)) this.#db.exec(`ALTER TABLE threads ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    }
    // Threads from before read tracking have no response on record, so they start out read.
    for (const column of ["archived_at", "responded_at", "read_at"]) {
      if (missing(column)) this.#db.exec(`ALTER TABLE threads ADD COLUMN ${column} INTEGER`);
    }
    const prColumns = this.#db.prepare(`PRAGMA table_info(pull_requests)`).all() as unknown as { name: string }[];
    if (!prColumns.some((column) => column.name === "head_oid")) {
      this.#db.exec(`ALTER TABLE pull_requests ADD COLUMN head_oid TEXT NOT NULL DEFAULT ''`);
    }
    // A briefly released version tracked what agents were told; merges now wake them instead.
    for (const column of ["seen_state", "parent_seen_state"]) {
      if (prColumns.some((existing) => existing.name === column)) {
        this.#db.exec(`ALTER TABLE pull_requests DROP COLUMN ${column}`);
      }
    }
    // An early development version created the inbox without kinds; its messages were all plain.
    const inboxColumns = this.#db.prepare(`PRAGMA table_info(inbox)`).all() as unknown as { name: string }[];
    if (!inboxColumns.some((column) => column.name === "kind")) {
      this.#db.exec(`ALTER TABLE inbox ADD COLUMN kind TEXT NOT NULL DEFAULT 'message'`);
    }
    // A server restart ends every provider process, so nothing can still be running.
    this.#db
      .prepare(`UPDATE threads SET status = 'idle' WHERE status IN ('running', 'preparing')`)
      .run();
  }

  listThreads(): StoredThread[] {
    const rows = this.#db.prepare(`${SELECT_THREADS} ORDER BY updated_at DESC`).all();
    return (rows as unknown as ThreadRow[]).map(fromRow);
  }

  getThread(id: string): StoredThread | undefined {
    const row = this.#db.prepare(`${SELECT_THREADS} WHERE id = ?`).get(id);
    return row ? fromRow(row as unknown as ThreadRow) : undefined;
  }

  insertThread(thread: StoredThread): void {
    this.#db
      .prepare(
        `INSERT INTO threads (id, project, title, provider, model, effort, access_mode, workspace,
          branch, status, provider_session_id, parent_id, start_branch, captain, watched, paused,
          archived_at, responded_at, read_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        thread.id,
        thread.project,
        thread.title,
        thread.provider,
        thread.model,
        thread.effort,
        thread.accessMode,
        thread.workspace,
        thread.branch,
        thread.status,
        thread.providerSessionId,
        thread.parentId,
        thread.startBranch,
        Number(thread.captain),
        Number(thread.watched),
        Number(thread.paused),
        thread.archivedAt,
        thread.respondedAt,
        thread.readAt,
        thread.createdAt,
        thread.updatedAt,
      );
  }

  /**
   * Only a status change counts as activity and moves updated_at, which orders the thread lists:
   * turns starting and ending, and workspaces becoming ready. Renames, settings, pauses and session
   * ids leave it alone, and so does reading. Delivered messages count too, through touchThread.
   */
  updateThread(
    id: string,
    patch: Partial<
      Pick<
        StoredThread,
        | "status"
        | "providerSessionId"
        | "title"
        | "model"
        | "effort"
        | "accessMode"
        | "workspace"
        | "branch"
        | "watched"
        | "paused"
        | "respondedAt"
        | "readAt"
      >
    >,
  ): StoredThread {
    const current = this.getThread(id);
    if (!current) throw new Error(`Unknown thread ${id}`);
    const active = patch.status !== undefined && patch.status !== current.status;
    const next: StoredThread = { ...current, ...patch, updatedAt: active ? Date.now() : current.updatedAt };
    this.#db
      .prepare(
        `UPDATE threads SET status = ?, provider_session_id = ?, title = ?, model = ?, effort = ?,
          access_mode = ?, workspace = ?, branch = ?, watched = ?, paused = ?, responded_at = ?, read_at = ?,
          updated_at = ? WHERE id = ?`,
      )
      .run(
        next.status,
        next.providerSessionId,
        next.title,
        next.model,
        next.effort,
        next.accessMode,
        next.workspace,
        next.branch,
        Number(next.watched),
        Number(next.paused),
        next.respondedAt,
        next.readAt,
        next.updatedAt,
        id,
      );
    return next;
  }

  touchThread(id: string): void {
    this.#db.prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(Date.now(), id);
  }

  /** Archiving is not activity, so it leaves updated_at alone and threads keep their place. */
  setArchived(ids: string[], archivedAt: number | null): void {
    const update = this.#db.prepare(`UPDATE threads SET archived_at = ? WHERE id = ?`);
    for (const id of ids) update.run(archivedAt, id);
  }

  enqueue(message: Omit<InboxMessage, "id" | "createdAt">): void {
    this.#db
      .prepare(`INSERT INTO inbox (id, thread_id, from_thread_id, kind, text, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), message.threadId, message.fromThreadId, message.kind, message.text, Date.now());
  }

  listInbox(threadId: string): InboxMessage[] {
    const rows = this.#db
      .prepare(
        `SELECT id, thread_id AS threadId, from_thread_id AS fromThreadId, kind, text, created_at AS createdAt
         FROM inbox WHERE thread_id = ? ORDER BY created_at, rowid`,
      )
      .all(threadId);
    return rows.map((row) => ({ ...(row as unknown as InboxMessage) }));
  }

  removeFromInbox(ids: string[]): void {
    const remove = this.#db.prepare(`DELETE FROM inbox WHERE id = ?`);
    for (const id of ids) remove.run(id);
  }

  /** Threads with messages waiting, for delivery after a restart. */
  threadsWithInbox(): string[] {
    const rows = this.#db.prepare(`SELECT DISTINCT thread_id AS id FROM inbox`).all() as unknown as { id: string }[];
    return rows.map((row) => row.id);
  }

  listChildren(parentId: string): StoredThread[] {
    const rows = this.#db.prepare(`${SELECT_THREADS} WHERE parent_id = ? ORDER BY created_at`).all(parentId);
    return (rows as unknown as ThreadRow[]).map(fromRow);
  }

  /** Children outlive their parent; they just lose the link. Returns the ids of those children. */
  deleteThread(id: string): string[] {
    const children = this.listChildren(id).map((child) => child.id);
    this.#db.prepare(`UPDATE threads SET parent_id = NULL WHERE parent_id = ?`).run(id);
    this.#db.prepare(`DELETE FROM threads WHERE id = ?`).run(id);
    return children;
  }

  listPullRequests(threadId: string): LinkedPullRequest[] {
    return this.#db
      .prepare(
        `SELECT repo, number, url, state, title, head_oid AS headOid FROM pull_requests
         WHERE thread_id = ? ORDER BY linked_at, rowid`,
      )
      .all(threadId)
      .map((row) => ({ ...(row as unknown as LinkedPullRequest) }));
  }

  /** Every thread's pull requests, optionally only those in one state, such as OPEN to poll. */
  listPullRequestLinks(state?: string): { threadId: string; pr: LinkedPullRequest }[] {
    return this.#db
      .prepare(
        `SELECT thread_id AS threadId, repo, number, url, state, title, head_oid AS headOid FROM pull_requests
         WHERE ? IS NULL OR state = ? ORDER BY linked_at, rowid`,
      )
      .all(state ?? null, state ?? null)
      .map((row) => {
        const { threadId, ...pr } = row as unknown as LinkedPullRequest & { threadId: string };
        return { threadId, pr };
      });
  }

  /** Links a pull request to a thread, or refreshes it. Returns whether anything changed. */
  linkPullRequest(threadId: string, pr: LinkedPullRequest): boolean {
    const result = this.#db
      .prepare(
        `INSERT INTO pull_requests (thread_id, url, repo, number, state, title, head_oid, linked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (thread_id, url) DO UPDATE
           SET state = excluded.state, title = excluded.title, head_oid = excluded.head_oid
         WHERE state != excluded.state OR title != excluded.title OR head_oid != excluded.head_oid`,
      )
      .run(threadId, pr.url, pr.repo, pr.number, pr.state, pr.title, pr.headOid, Date.now());
    return Number(result.changes) > 0;
  }

  listItems(threadId: string): Item[] {
    const rows = this.#db
      .prepare(`SELECT data FROM items WHERE thread_id = ? ORDER BY seq`)
      .all(threadId) as unknown as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as Item);
  }

  /** Inserts or replaces an item, keeping its original position in the transcript. */
  upsertItem(threadId: string, item: Item): void {
    this.#db
      .prepare(
        `INSERT INTO items (thread_id, id, seq, data)
         VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM items WHERE thread_id = ?), ?)
         ON CONFLICT (thread_id, id) DO UPDATE SET data = excluded.data`,
      )
      .run(threadId, item.id, threadId, JSON.stringify(item));
  }
}
