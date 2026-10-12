import assert from "node:assert/strict";
import { test } from "node:test";
import type { LinkedPullRequest, Thread } from "shared/protocol";
import { defaultFilter, filterThreads } from "../../web/src/lib/sidebarFilter.ts";
import { autoArchiveChanged, threadsToArchive } from "./autoArchive.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

type Fields = Partial<Pick<Thread, "parentId" | "archivedAt" | "status" | "waiting" | "respondedAt" | "readAt" | "markedUnread" | "updatedAt">>;

/** Last active ten days ago and read since, unless the fields say otherwise. */
const thread = (id: string, fields: Fields = {}) => ({
  id,
  project: "demo",
  parentId: null,
  archivedAt: null,
  status: "idle" as Thread["status"],
  waiting: false,
  respondedAt: NOW - 10 * DAY,
  readAt: NOW - 10 * DAY,
  markedUnread: false,
  updatedAt: NOW - 10 * DAY,
  ...fields,
});

const pr = (state: string) => ({ state }) as LinkedPullRequest;
const archive = (threads: ReturnType<typeof thread>[], pullRequests: Record<string, LinkedPullRequest[]> = {}, days = 7) =>
  threadsToArchive(threads, (id) => pullRequests[id] ?? [], days, NOW);

test("a thread is archived once its last turn, message or read is older than the threshold", () => {
  assert.deepEqual(archive([thread("old")]), ["old"]);
  assert.deepEqual(archive([thread("old")], {}, 10), []);
  assert.deepEqual(archive([thread("old")], {}, 9), ["old"]);
  assert.deepEqual(archive([thread("worked", { updatedAt: NOW - 6 * DAY })]), []);
  // Read yesterday, though nothing happened for weeks: the user is still looking at it.
  assert.deepEqual(archive([thread("read", { readAt: NOW - DAY })]), []);
  // A merged pull request wakes its thread, which moves updatedAt; so does any delivered message.
  assert.deepEqual(archive([thread("merged", { updatedAt: NOW - DAY })], { merged: [pr("MERGED")] }), []);
  assert.deepEqual(archive([thread("never read", { respondedAt: null, readAt: null })]), ["never read"]);
});

test("working, waiting, unread, marked unread or an open pull request keeps a thread", () => {
  const threads = [
    thread("running", { status: "running" }),
    thread("preparing", { status: "preparing" }),
    thread("waiting", { waiting: true }),
    thread("unread", { respondedAt: NOW - 9 * DAY }),
    thread("marked", { markedUnread: true }),
    thread("open pr"),
    thread("closed pr"),
    thread("failed", { status: "error" }),
  ];
  assert.deepEqual(archive(threads, { "open pr": [pr("MERGED"), pr("OPEN")], "closed pr": [pr("CLOSED")] }), [
    "closed pr",
    "failed",
  ]);
});

test("a parent goes only with its whole subtree, and an inactive child can go without its parent", () => {
  const threads = [
    thread("captain"),
    thread("lead", { parentId: "captain" }),
    thread("busy", { parentId: "lead", status: "running" }),
    thread("done", { parentId: "lead" }),
    thread("lonely"),
    thread("finished", { parentId: "lonely" }),
    thread("tucked", { parentId: "lonely", archivedAt: NOW - 50 * DAY, status: "error", markedUnread: true }),
    thread("recent"),
    thread("stale", { parentId: "recent" }),
  ].map((each) => (each.id === "recent" ? { ...each, updatedAt: NOW - DAY } : each));
  // Archived threads are already out of the way, so they never hold back their parent.
  assert.deepEqual(archive(threads), ["done", "lonely", "stale"]);
});

test("the server's inactive threads are exactly the ones the sidebar hides", () => {
  const threads = [
    thread("running", { status: "running" }),
    thread("waiting", { waiting: true }),
    thread("unread", { respondedAt: NOW - 9 * DAY }),
    thread("marked", { markedUnread: true }),
    thread("open pr"),
    thread("merged pr"),
    thread("idle"),
    thread("failed", { status: "error" }),
  ];
  const pullRequests = { "open pr": [pr("OPEN")], "merged pr": [pr("MERGED")] };
  const { shown } = filterThreads(threads, { filter: defaultFilter, pullRequests });
  const hidden = threads.filter((each) => !shown.includes(each)).map((each) => each.id);
  assert.deepEqual(archive(threads, pullRequests), hidden);
  assert.deepEqual(hidden, ["merged pr", "idle", "failed"]);
});

test("turning archiving on or changing its days runs it at once", () => {
  const on = { enabled: true, days: 7 };
  assert.equal(autoArchiveChanged({ enabled: false, days: 7 }, on), true);
  assert.equal(autoArchiveChanged(on, { enabled: true, days: 3 }), true);
  assert.equal(autoArchiveChanged(on, on), false);
  assert.equal(autoArchiveChanged(on, { enabled: false, days: 3 }), false);
});
