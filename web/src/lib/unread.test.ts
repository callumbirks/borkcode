import assert from "node:assert/strict";
import { test } from "node:test";
import { autoReadDue, isUnread, nextHold } from "./unread.ts";

const thread = (id: string, patch: { respondedAt?: number | null; readAt?: number | null; markedUnread?: boolean } = {}) => ({
  id,
  respondedAt: null,
  readAt: null,
  markedUnread: false,
  ...patch,
});

test("a thread is unread after a response it has not been read since, or when marked unread", () => {
  assert.equal(isUnread(thread("a")), false);
  assert.equal(isUnread(thread("a", { respondedAt: 2, readAt: 1 })), true);
  assert.equal(isUnread(thread("a", { respondedAt: 2, readAt: 3 })), false);
  assert.equal(isUnread(thread("a", { markedUnread: true })), true);
  assert.equal(isUnread(thread("a", { respondedAt: 2, readAt: 3, markedUnread: true })), true);
});

test("marking the open thread unread holds off reading it automatically", () => {
  const read = thread("a", { respondedAt: 2, readAt: 3 });
  const marked = { ...read, markedUnread: true };
  const hold = nextHold(null, "a", read, marked);
  assert.deepEqual(hold, { threadId: "a", respondedAt: 2 });
  assert.equal(autoReadDue(marked, hold), false);
  // Later updates to the same thread keep the hold.
  assert.equal(nextHold(hold, "a", marked, { ...marked }), hold);
});

test("a new response lifts the hold", () => {
  const marked = thread("a", { respondedAt: 2, readAt: 3, markedUnread: true });
  const hold = { threadId: "a", respondedAt: 2 };
  assert.equal(autoReadDue({ ...marked, respondedAt: 5 }, hold), true);
});

test("opening another thread ends the hold, so coming back reads the thread", () => {
  const marked = thread("a", { markedUnread: true });
  const hold = nextHold(null, "a", thread("a"), marked);
  assert.equal(nextHold(hold, "b", marked, undefined), null);
  // Opening a thread that is already marked unread is not marking it, so it is read as usual.
  assert.equal(nextHold(null, "a", undefined, marked), null);
  assert.equal(autoReadDue(marked, null), true);
});

test("a hold does not survive being read, and a read thread is never due", () => {
  const hold = { threadId: "a", respondedAt: null };
  assert.equal(autoReadDue(thread("a", { readAt: 4 }), hold), false);
  assert.equal(autoReadDue(thread("a", { readAt: 4 }), null), false);
});
