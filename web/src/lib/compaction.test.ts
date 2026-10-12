import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "shared/protocol";
import { compactionLabel, formatTokens, isCompacting } from "./compaction.ts";

const compaction = (fields: Partial<Extract<Item, { kind: "compaction" }>>): Extract<Item, { kind: "compaction" }> => ({
  id: "c",
  kind: "compaction",
  status: "done",
  trigger: "manual",
  tokensBefore: 4294,
  tokensAfter: 972,
  summary: null,
  ...fields,
});

test("token counts read like the providers' own", () => {
  assert.equal(formatTokens(972), "972");
  assert.equal(formatTokens(4294), "4.3k");
  assert.equal(formatTokens(16000), "16k");
  assert.equal(formatTokens(1_250_000), "1.3M");
});

test("the compaction marker says what happened and what the provider reported", () => {
  assert.deepEqual(compactionLabel(compaction({}), false), { title: "Context compacted", details: ["manual", "4.3k → 972 tokens"] });
  assert.deepEqual(compactionLabel(compaction({ trigger: "auto", tokensAfter: null }), false), {
    title: "Context compacted",
    details: ["automatically", "from 4.3k tokens"],
  });
  assert.deepEqual(compactionLabel(compaction({ trigger: null, tokensBefore: null, tokensAfter: null }), false), {
    title: "Context compacted",
    details: [],
  });
  assert.deepEqual(compactionLabel(compaction({ status: "running" }), true), { title: "Compacting context…", details: [] });
  assert.deepEqual(compactionLabel(compaction({ status: "running" }), false), { title: "Compaction did not finish", details: [] });
  assert.deepEqual(compactionLabel(compaction({ status: "failed", error: "Not enough messages" }), false), {
    title: "Compaction failed",
    details: ["Not enough messages"],
  });
});

test("a thread is compacting while its current turn's latest compaction runs", () => {
  const user: Item = { id: "u", kind: "user", text: "/compact" };
  const reply: Item = { id: "a", kind: "assistant", text: "ok" };
  assert.equal(isCompacting([user, compaction({ status: "running" })]), true);
  assert.equal(isCompacting([user, compaction({ status: "running" }), reply]), true);
  assert.equal(isCompacting([user, compaction({})]), false);
  assert.equal(isCompacting([compaction({ status: "running" }), user]), false);
  assert.equal(isCompacting([]), false);
});
