import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Item } from "shared/protocol";
import { Database, toThread, type StoredThread } from "./db.ts";
import { ProjectStore } from "./projects.ts";
import { ITEM_CHARACTERS, PAGE_CHARACTERS, ThreadReferences } from "./threadReferences.ts";

const home = await mkdtemp(join(tmpdir(), "borkcode-references-"));
after(() => rm(home, { recursive: true, force: true }));
const projects = new ProjectStore(home);
await projects.create("demo");
await projects.create("other");
const db = new Database(join(home, "db.sqlite"));
function seed(id: string, patch: Partial<StoredThread> = {}) {
  const t: StoredThread = { id, project: "demo", title: id, provider: "codex", model: null, effort: null,
    accessMode: "full", fastMode: false, workspace: null, branch: null, status: "idle", parentId: null, captain: false,
    watched: false, queued: 0, paused: false, archivedAt: null, respondedAt: 100, readAt: null, markedUnread: false,
    createdAt: 1, updatedAt: 100, providerSessionId: null, startBranch: null, ...patch };
  db.insertThread(t);
  return t;
}
const refs = new ThreadReferences(db, projects, () => db.listThreads().map(t => toThread(t, false)));

seed("paging");
for (let i = 1; i <= 8; i++) db.upsertItem("paging", { id: `m${i}`, kind: i === 4 ? "reasoning" : "assistant", text: `Message ${i}` });

test("end pages are chronological and cursors advance older across skipped reasoning", () => {
  const p1 = refs.readThread("paging", "end", undefined, 3);
  assert.deepEqual(p1.messages.map(m => m.seq), [6, 7, 8]);
  const p2 = refs.readThread("paging", "end", p1.next_cursor!, 3);
  assert.deepEqual(p2.messages.map(m => m.seq), [2, 3, 5]);
  const p3 = refs.readThread("paging", "end", p2.next_cursor!, 3);
  assert.deepEqual(p3.messages.map(m => m.seq), [1]);
  assert.equal(p3.more, false);
  assert.equal(p3.next_cursor, null);
});

test("start pages advance newer, including new messages after a cursor was issued", () => {
  const p1 = refs.readThread("paging", "start", undefined, 3);
  assert.deepEqual(p1.messages.map(m => m.seq), [1, 2, 3]);
  db.upsertItem("paging", { id: "m9", kind: "assistant", text: "New message" });
  db.upsertItem("paging", { id: "m2", kind: "assistant", text: "Updated message" });
  const p2 = refs.readThread("paging", "start", p1.next_cursor!, 3);
  assert.deepEqual(p2.messages.map(m => m.seq), [5, 6, 7]);
  const p3 = refs.readThread("paging", "start", p2.next_cursor!, 3);
  assert.deepEqual(p3.messages.map(m => m.seq), [8, 9]);
  assert.equal(p3.more, false);
});

test("an item moved to the end pages once, after the items it moved past", () => {
  seed("moved");
  for (let i = 1; i <= 5; i++) db.upsertItem("moved", { id: `m${i}`, kind: "assistant", text: `Message ${i}` });
  db.upsertItem("moved", { id: "m2", kind: "assistant", text: "Moved" }, true);
  const ids = (from: "start" | "end") => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = refs.readThread("moved", from, cursor, 2);
      seen.push(...(from === "end" ? page.messages.reverse() : page.messages).map(m => m.id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return seen;
  };
  assert.deepEqual(ids("start"), ["m1", "m3", "m4", "m5", "m2"]);
  assert.deepEqual(ids("end"), ["m2", "m5", "m4", "m3", "m1"]);
});

test("text truncation and page budget still allow reading every item and its complete text", () => {
  seed("long");
  for (let i = 0; i < 15; i++) db.upsertItem("long", { id: `long${i}`, kind: "assistant", text: "x".repeat(40_000) });
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = refs.readThread("long", "end", cursor, 50);
    assert.ok(JSON.stringify(page.messages).length <= PAGE_CHARACTERS);
    assert.ok(page.messages.every(m => m.text.length <= ITEM_CHARACTERS && m.truncated && m.text.includes("[truncated")));
    seen.push(...page.messages.map(m => m.id));
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  assert.equal(new Set(seen).size, 15);
  let full = "", offset = 0;
  do {
    const chunk = refs.readItem("long", "long0", offset);
    full += chunk.text;
    if (chunk.next_offset === null) break;
    offset = chunk.next_offset;
  } while (true);
  assert.equal(full, "x".repeat(40_000));
});

test("tool calls are one line without outputs; all public item kinds and sources are readable", () => {
  seed("kinds");
  const items: Item[] = [
    { id: "u", kind: "user", text: "User" },
    { id: "t", kind: "user", text: "Report", fromThreadId: "paging" },
    { id: "b", kind: "user", text: "News", fromBorkcode: true },
    { id: "tool", kind: "tool", name: "exec", summary: "ls\nfiles", output: "SECRET OUTPUT", status: "done" },
    { id: "r", kind: "reasoning", text: "PRIVATE" },
    { id: "q", kind: "question", questions: [{ header: "Pick", question: "Which?", options: [], multiSelect: false }], answers: [["A"]] },
    { id: "v", kind: "visualization", title: "Diagram", updatedAt: 1 },
    { id: "h", kind: "thread", threadId: "paging" },
    { id: "n", kind: "notice", text: "Stopped", level: "info" },
  ];
  items.forEach(i => db.upsertItem("kinds", i));
  const page = refs.readThread("kinds");
  assert.deepEqual(page.messages.slice(0, 3).map(m => m.source), ["user", "thread:paging", "borkcode"]);
  assert.equal(page.messages.find(m => m.id === "tool")?.text, "exec: ls files (done)");
  assert.match(page.messages.find(m => m.id === "q")!.text, /Answer: A/);
  assert.equal(page.messages.length, 8);
  assert.ok(!JSON.stringify(page).includes("SECRET OUTPUT"));
  assert.ok(!JSON.stringify(page).includes("PRIVATE"));
  assert.throws(() => refs.readItem("kinds", "r"), /Reasoning/);
});

test("discovery includes details, archive filtering, cross-project reads, PRs and list cursors", async () => {
  await writeFile(join(projects.projectPath("other"), "project.json"), JSON.stringify({ repos: [], description: "Other work" }));
  seed("archived", { archivedAt: 1, updatedAt: 500 });
  seed("cross", { project: "other", updatedAt: 600, captain: true });
  db.linkPullRequest("cross", { repo: "app", number: 3, state: "MERGED", title: "Change", url: "https://example.com/3", headOid: "abc" });
  const info = (await refs.listProjects("other"))[0];
  assert.equal(info.description, "Other work");
  assert.equal(info.filesRoot, join(projects.projectPath("other"), "files"));
  assert.equal(info.threads.active, 1);
  const first = await refs.listThreads("demo", true, undefined, 1);
  assert.equal(first.threads[0].id, "archived");
  const second = await refs.listThreads("demo", true, first.next_cursor!, 1);
  assert.notEqual(second.threads[0].id, "archived");
  assert.ok(!(await refs.listThreads("demo")).threads.some(t => t.id === "archived"));
  assert.equal((await refs.listThreads("other")).threads[0].pullRequests[0].state, "MERGED");
  assert.equal(refs.readThread("cross").thread.project, "other");
});

test("unknown IDs and invalid cursors fail clearly; reads preserve thread and inbox state", async () => {
  const before = db.getThread("paging");
  refs.readThread("paging");
  refs.readItem("paging", "m1");
  await refs.listThreads("demo");
  assert.deepEqual(db.getThread("paging"), before);
  assert.throws(() => refs.readThread("unknown"), /Unknown thread/);
  assert.throws(() => refs.readItem("paging", "missing"), /Unknown item/);
  assert.throws(() => refs.readThread("paging", "start", "paging:end:5"), /cursor/);
  assert.throws(() => refs.readThread("paging", "end", "paging:end:NaN"), /cursor/);
  assert.throws(() => refs.readThread("paging", "end", undefined, 0), /limit/);
  await assert.rejects(refs.listThreads("missing"), /Unknown project/);
  await assert.rejects(refs.listThreads("demo", false, "bad"), /cursor/);
});

test("thread discovery includes manual unread marks and reading preserves them", async () => {
  const cases = [
    { markedUnread: true, respondedAt: null, readAt: null, unread: true },
    { markedUnread: true, respondedAt: 100, readAt: 200, unread: true },
    { markedUnread: false, respondedAt: 100, readAt: null, unread: true },
    { markedUnread: false, respondedAt: 100, readAt: 50, unread: true },
    { markedUnread: false, respondedAt: 100, readAt: 100, unread: false },
    { markedUnread: false, respondedAt: null, readAt: null, unread: false },
    { markedUnread: false, respondedAt: 0, readAt: null, unread: false },
  ];
  for (const [index, { unread, ...state }] of cases.entries()) {
    const id = `read-state-${index}`;
    seed(id, state);
    db.upsertItem(id, { id: "message", kind: "assistant", text: "A message" });
    const before = db.getThread(id);
    assert.equal((await refs.listThreads("demo")).threads.find(t => t.id === id)?.unread, unread);
    refs.readThread(id);
    refs.readItem(id, "message");
    assert.deepEqual(db.getThread(id), before);
  }
});
