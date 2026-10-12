import assert from "node:assert/strict";
import { test } from "node:test";
import { workingInSubtree } from "./threadTree.ts";

const thread = (id: string, parentId: string | null, status: "idle" | "running" | "preparing" = "idle") => ({
  id,
  parentId,
  status,
  title: id,
});

test("a working thread anywhere below blocks archiving, but not one above or beside", () => {
  const threads = [thread("root", null), thread("child", "root"), thread("grandchild", "child", "running"), thread("other", null, "running")];
  assert.equal(workingInSubtree(threads, "root")?.id, "grandchild");
  assert.equal(workingInSubtree(threads, "child")?.id, "grandchild");
  assert.equal(workingInSubtree(threads, "other")?.id, "other");
  assert.equal(workingInSubtree([thread("a", null), thread("b", "a", "preparing")], "a")?.id, "b");
  assert.equal(workingInSubtree([thread("a", null), thread("b", null, "running")], "a"), undefined);
});
