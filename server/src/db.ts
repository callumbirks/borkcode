import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Item, LinkedPullRequest, Thread } from "shared/protocol";

export interface StoredThread extends Thread {
  /** Provider-native session or thread id, used to resume after a restart. */
  providerSessionId: string | null;
}

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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toThread({ providerSessionId: _, ...thread }: StoredThread): Thread {
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
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
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
    if (!columns.some((column) => column.name === "effort")) {
      this.#db.exec(`ALTER TABLE threads ADD COLUMN effort TEXT`);
    }
    const prColumns = this.#db.prepare(`PRAGMA table_info(pull_requests)`).all() as unknown as { name: string }[];
    if (!prColumns.some((column) => column.name === "head_oid")) {
      this.#db.exec(`ALTER TABLE pull_requests ADD COLUMN head_oid TEXT NOT NULL DEFAULT ''`);
    }
    // A server restart ends every provider process, so nothing can still be running.
    this.#db
      .prepare(`UPDATE threads SET status = 'idle' WHERE status IN ('running', 'preparing')`)
      .run();
  }

  listThreads(): StoredThread[] {
    const rows = this.#db.prepare(`SELECT * FROM threads ORDER BY updated_at DESC`).all();
    return (rows as unknown as ThreadRow[]).map(fromRow);
  }

  getThread(id: string): StoredThread | undefined {
    const row = this.#db.prepare(`SELECT * FROM threads WHERE id = ?`).get(id);
    return row ? fromRow(row as unknown as ThreadRow) : undefined;
  }

  insertThread(thread: StoredThread): void {
    this.#db
      .prepare(
        `INSERT INTO threads (id, project, title, provider, model, effort, access_mode, workspace,
          branch, status, provider_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        thread.createdAt,
        thread.updatedAt,
      );
  }

  updateThread(
    id: string,
    patch: Partial<
      Pick<StoredThread, "status" | "providerSessionId" | "title" | "model" | "effort" | "workspace" | "branch">
    >,
  ): StoredThread {
    const current = this.getThread(id);
    if (!current) throw new Error(`Unknown thread ${id}`);
    const next: StoredThread = { ...current, ...patch, updatedAt: Date.now() };
    this.#db
      .prepare(
        `UPDATE threads SET status = ?, provider_session_id = ?, title = ?, model = ?, effort = ?,
          workspace = ?, branch = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.status,
        next.providerSessionId,
        next.title,
        next.model,
        next.effort,
        next.workspace,
        next.branch,
        next.updatedAt,
        id,
      );
    return next;
  }

  deleteThread(id: string): void {
    this.#db.prepare(`DELETE FROM threads WHERE id = ?`).run(id);
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
