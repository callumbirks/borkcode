import assert from "node:assert/strict";
import { test } from "node:test";
import type { LinkedPullRequest } from "shared/protocol";
import { defaultFilter, filterThreads, isActive, isDefaultFilter, parseFilter } from "./sidebarFilter.ts";

type Status = "idle" | "running" | "preparing" | "error";

const thread = (id: string, fields: { parentId?: string; project?: string; captain?: boolean; status?: Status; waiting?: boolean; unread?: boolean; markedUnread?: boolean } = {}) => ({
  id,
  parentId: fields.parentId ?? null,
  project: fields.project ?? "alpha",
  captain: fields.captain ?? false,
  status: fields.status ?? "idle",
  waiting: fields.waiting ?? false,
  respondedAt: fields.unread ? 200 : 100,
  readAt: 150,
  markedUnread: fields.markedUnread ?? false,
});

const pr = (state: string) => ({ state }) as LinkedPullRequest;

const shownIds = (result: { shown: { id: string }[] }) => result.shown.map((entry) => entry.id);

test("a thread is active while working, waiting, unread or with an open pull request", () => {
  assert.equal(isActive(thread("a"), undefined), false);
  assert.equal(isActive(thread("a", { status: "error" }), []), false);
  assert.equal(isActive(thread("a", { status: "running" }), undefined), true);
  assert.equal(isActive(thread("a", { status: "preparing" }), undefined), true);
  assert.equal(isActive(thread("a", { waiting: true }), undefined), true);
  assert.equal(isActive(thread("a", { unread: true }), undefined), true);
  assert.equal(isActive(thread("a", { markedUnread: true }), undefined), true);
  assert.equal(isActive(thread("a"), [pr("OPEN")]), true);
  assert.equal(isActive(thread("a"), [pr("MERGED"), pr("CLOSED")]), false);
});

test("a captain is always active, so it stays listed while idle and read, unless its project is excluded", () => {
  assert.equal(isActive(thread("captain", { captain: true }), undefined), true);
  assert.equal(isActive(thread("captain", { captain: true, status: "error" }), [pr("MERGED")]), true);
  const threads = [thread("captain", { captain: true }), thread("done", { parentId: "captain" }), thread("other", { project: "beta", captain: true })];
  const result = filterThreads(threads, { filter: { ...defaultFilter, excludedProjects: ["beta"] }, pullRequests: {} });
  assert.deepEqual(shownIds(result), ["captain"]);
  assert.deepEqual([...result.hidden], [["alpha", 1]]);
});

test("hiding inactive threads lists the active ones in order and counts the rest per project", () => {
  const threads = [
    thread("running", { status: "running" }),
    thread("idle"),
    thread("unread", { unread: true }),
    thread("merged"),
    thread("other", { project: "beta" }),
  ];
  const result = filterThreads(threads, { filter: defaultFilter, pullRequests: { merged: [pr("MERGED")] } });
  assert.deepEqual(shownIds(result), ["running", "unread"]);
  assert.deepEqual([...result.hidden], [["alpha", 2], ["beta", 1]]);

  const all = filterThreads(threads, { filter: { ...defaultFilter, hideInactive: false }, pullRequests: {} });
  assert.equal(all.shown.length, threads.length);
  assert.equal(all.hidden.size, 0);
});

test("a shown thread shows its ancestors, but not its inactive siblings", () => {
  const threads = [
    thread("captain"),
    thread("lead", { parentId: "captain" }),
    thread("worker", { parentId: "lead", waiting: true }),
    thread("sibling", { parentId: "lead" }),
    thread("lonely-captain"),
    thread("done", { parentId: "lonely-captain" }),
  ];
  const result = filterThreads(threads, { filter: defaultFilter, pullRequests: {} });
  assert.deepEqual(shownIds(result), ["captain", "lead", "worker"]);
  assert.equal(result.hidden.get("alpha"), 3);
});

test("the open thread stays listed with its ancestors even when inactive", () => {
  const threads = [thread("captain"), thread("child", { parentId: "captain" }), thread("idle")];
  const result = filterThreads(threads, { filter: defaultFilter, pullRequests: {}, keep: ["child"] });
  assert.deepEqual(shownIds(result), ["captain", "child"]);
  assert.equal(result.hidden.get("alpha"), 1);
});

test("an excluded project lists and counts nothing, even its open or active threads", () => {
  const threads = [thread("a", { status: "running" }), thread("b", { project: "beta", status: "running" }), thread("c", { project: "beta" })];
  const result = filterThreads(threads, { filter: { excludedProjects: ["beta"], hideInactive: true }, pullRequests: {}, keep: ["c"] });
  assert.deepEqual(shownIds(result), ["a"]);
  assert.equal(result.hidden.has("beta"), false);
});

test("revealing a project shows its inactive threads without touching the others", () => {
  const threads = [thread("a"), thread("b", { project: "beta" })];
  const result = filterThreads(threads, { filter: defaultFilter, pullRequests: {}, showInactiveIn: new Set(["beta"]) });
  assert.deepEqual(shownIds(result), ["b"]);
  assert.deepEqual([...result.hidden], [["alpha", 1]]);
});

test("a stored filter falls back to the defaults for anything missing or malformed", () => {
  assert.deepEqual(parseFilter(null), defaultFilter);
  assert.deepEqual(parseFilter("not json"), defaultFilter);
  assert.deepEqual(parseFilter('{"hideInactive":"no","excludedProjects":["beta",3]}'), { excludedProjects: ["beta"], hideInactive: true });
  assert.deepEqual(parseFilter('{"hideInactive":false}'), { excludedProjects: [], hideInactive: false });
  assert.equal(isDefaultFilter(defaultFilter), true);
  assert.equal(isDefaultFilter({ excludedProjects: [], hideInactive: false }), false);
  assert.equal(isDefaultFilter({ excludedProjects: ["beta"], hideInactive: true }), false);
});
