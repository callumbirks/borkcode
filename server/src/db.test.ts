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
  const updated = db.updateThread("t1", { effort: "high", model: "gpt-6-luna", title: "Renamed" });
  assert.deepEqual(
    { effort: updated.effort, model: updated.model, title: updated.title, workspace: updated.workspace },
    { effort: "high", model: "gpt-6-luna", title: "Renamed", workspace: "old-t1" },
  );
  assert.equal(new Database(path).getThread("t1")?.effort, "high");
});
