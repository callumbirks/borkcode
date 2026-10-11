import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { Database } from "./db.ts";

const scratch = await mkdtemp(join(tmpdir(), "borkcode-db-"));
after(() => rm(scratch, { recursive: true, force: true }));

test("databases from before effort existed gain the column and keep their threads", () => {
  const path = join(scratch, "old.sqlite");
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, provider TEXT NOT NULL,
      model TEXT, access_mode TEXT NOT NULL, workspace TEXT, branch TEXT, status TEXT NOT NULL,
      provider_session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO threads VALUES ('t1', 'p', 'Old thread', 'codex', 'gpt-6-sol', 'ask', 'old-t1', 'borkcode/old-t1', 'idle', NULL, 1, 1);
  `);
  old.close();

  const db = new Database(path);
  assert.equal(db.getThread("t1")?.effort, null);
  assert.equal(db.getThread("t1")?.archivedAt, null);
  const updated = db.updateThread("t1", { effort: "high", model: "gpt-6-luna", title: "Renamed" });
  assert.deepEqual(
    { effort: updated.effort, model: updated.model, title: updated.title, workspace: updated.workspace },
    { effort: "high", model: "gpt-6-luna", title: "Renamed", workspace: "old-t1" },
  );
  assert.equal(new Database(path).getThread("t1")?.effort, "high");
});

test("linking a pull request reports changes only when something changed", () => {
  const db = new Database(":memory:");
  db.insertThread({
    id: "t2", project: "p", title: "T", provider: "claude", model: null, effort: null, accessMode: "ask",
    workspace: "t-t2", branch: "borkcode/t-t2", status: "idle", providerSessionId: null, parentId: null, startBranch: null,
    captain: false, watched: false, paused: false, queued: 0, archivedAt: null,
    createdAt: 1, updatedAt: 1,
  });
  const pr = { repo: "alpha", number: 4, url: "https://github.com/me/alpha/pull/4", state: "OPEN", title: "Fix", headOid: "abc" };
  assert.equal(db.linkPullRequest("t2", pr), true);
  assert.equal(db.linkPullRequest("t2", pr), false);
  assert.equal(db.linkPullRequest("t2", { ...pr, state: "MERGED" }), true);
  assert.deepEqual(db.listPullRequests("t2"), [{ ...pr, state: "MERGED" }]);
  db.deleteThread("t2");
  assert.deepEqual(db.listPullRequests("t2"), []);
});

test("pull request links from before head commits were stored gain the column", () => {
  const path = join(scratch, "old-prs.sqlite");
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, provider TEXT NOT NULL,
      model TEXT, effort TEXT, access_mode TEXT NOT NULL, workspace TEXT, branch TEXT, status TEXT NOT NULL,
      provider_session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO threads VALUES ('t3', 'p', 'T', 'codex', NULL, NULL, 'ask', 'w', 'borkcode/w', 'idle', NULL, 1, 1);
    CREATE TABLE pull_requests (
      thread_id TEXT NOT NULL, url TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
      state TEXT NOT NULL, title TEXT NOT NULL, linked_at INTEGER NOT NULL, PRIMARY KEY (thread_id, url)
    );
    INSERT INTO pull_requests VALUES ('t3', 'https://github.com/me/a/pull/1', 'a', 1, 'MERGED', 'Old', 1);
  `);
  old.close();

  const db = new Database(path);
  const [pr] = db.listPullRequests("t3");
  assert.equal(pr?.headOid, "");
  // Discovery fills it in later.
  assert.equal(db.linkPullRequest("t3", { ...pr!, headOid: "def" }), true);
  assert.equal(db.listPullRequests("t3")[0]?.headOid, "def");
});

test("deleting a parent keeps its children and drops their link", () => {
  const db = new Database(":memory:");
  const base = {
    project: "p", title: "T", provider: "claude" as const, model: null, effort: null, accessMode: "ask" as const,
    workspace: null, branch: null, status: "idle" as const, providerSessionId: null, startBranch: null, createdAt: 1, updatedAt: 1,
    captain: false, watched: false, paused: false, queued: 0, archivedAt: null,
  };
  db.insertThread({ ...base, id: "parent", parentId: null });
  db.insertThread({ ...base, id: "child", parentId: "parent", startBranch: "borkcode/parent" });
  assert.deepEqual(db.listChildren("parent").map((thread) => thread.id), ["child"]);
  assert.equal(db.getThread("child")?.startBranch, "borkcode/parent");
  assert.deepEqual(db.deleteThread("parent"), ["child"]);
  assert.equal(db.getThread("child")?.parentId, null);
});

test("an inbox created before messages had kinds gains the column and keeps its messages", () => {
  const path = join(scratch, "old-inbox.sqlite");
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, provider TEXT NOT NULL,
      model TEXT, effort TEXT, access_mode TEXT NOT NULL, workspace TEXT, branch TEXT, status TEXT NOT NULL,
      provider_session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO threads VALUES ('t4', 'p', 'T', 'codex', NULL, NULL, 'ask', 'w', 'borkcode/w', 'idle', NULL, 1, 1);
    CREATE TABLE inbox (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, from_thread_id TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    INSERT INTO inbox VALUES ('m1', 't4', NULL, 'queued before', 1);
  `);
  old.close();

  const db = new Database(path);
  db.enqueue({ threadId: "t4", fromThreadId: null, kind: "message", text: "queued after" });
  assert.deepEqual(
    db.listInbox("t4").map((message) => [message.text, message.kind]),
    [
      ["queued before", "message"],
      ["queued after", "message"],
    ],
  );
});

test("archiving is stored without counting as activity", () => {
  const db = new Database(":memory:");
  db.insertThread({
    id: "t5", project: "p", title: "T", provider: "claude", model: null, effort: null, accessMode: "ask",
    workspace: null, branch: null, status: "idle", providerSessionId: null, parentId: null, startBranch: null,
    captain: false, watched: false, paused: false, queued: 0, archivedAt: null, createdAt: 1, updatedAt: 1,
  });
  db.setArchived(["t5"], 42);
  assert.deepEqual([db.getThread("t5")?.archivedAt, db.getThread("t5")?.updatedAt], [42, 1]);
  // Later updates keep it archived.
  db.updateThread("t5", { title: "Renamed" });
  assert.equal(db.getThread("t5")?.archivedAt, 42);
  db.setArchived(["t5"], null);
  assert.equal(db.getThread("t5")?.archivedAt, null);
});
