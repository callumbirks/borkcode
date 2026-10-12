import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "shared/protocol";
import { segmentItems } from "./segments.ts";

const user = (id: string): Item => ({ id, kind: "user", text: id });
const tool = (id: string): Item => ({ id, kind: "tool", name: "Bash", summary: id, status: "done", output: "" });
const thinking = (id: string): Item => ({ id, kind: "reasoning", text: id });

test("tool calls and reasoning between messages fold into one work segment", () => {
  const items = [user("a"), tool("t1"), thinking("r1"), tool("t2"), user("b"), tool("t3")];
  assert.deepEqual(segmentItems(items), [
    { kind: "item", item: items[0] },
    { kind: "work", id: "t1", items: [items[1], items[2], items[3]] },
    { kind: "item", item: items[4] },
    { kind: "work", id: "t3", items: [items[5]] },
  ]);
});

test("segments whose items are unchanged keep their identity", () => {
  const items = [user("a"), tool("t1"), tool("t2"), user("b"), tool("t3")];
  const before = segmentItems(items);
  // One tool call is replaced, as an upsert does, and a new message arrives.
  const next = [...items.slice(0, 4), tool("t3"), user("c")];
  const after = segmentItems(next, before);
  assert.equal(after[0], before[0]);
  assert.equal(after[1], before[1]);
  assert.equal(after[2], before[2]);
  assert.notEqual(after[3], before[3]);
  assert.deepEqual(after[3], { kind: "work", id: "t3", items: [next[4]] });
  assert.deepEqual(after[4], { kind: "item", item: next[5] });
});

test("a work segment that gains a step is new", () => {
  const items = [user("a"), tool("t1")];
  const before = segmentItems(items);
  const after = segmentItems([...items, tool("t2")], before);
  assert.equal(after[0], before[0]);
  assert.notEqual(after[1], before[1]);
});
