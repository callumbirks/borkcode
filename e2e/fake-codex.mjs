#!/usr/bin/env node
// Stands in for `codex app-server` in the browser tests, so sending a message runs a real turn
// through the server without a provider. Each turn streams a short reply in deltas, ending with
// the service tier it was asked for, which is how fast mode reaches Codex. `thread/compact/start`
// compacts as Codex does, holding the compaction until the test creates `release-compaction` in
// the server's home, so a test can see it running.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const notify = (method, params) => send({ method, params });
let turns = 0;

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "model/list") {
    const efforts = (...levels) => levels.map((reasoningEffort) => ({ reasoningEffort }));
    return send({ id, result: { nextCursor: null, data: [
      { model: "fake", displayName: "Fake", isDefault: true, hidden: false, supportedReasoningEfforts: efforts("low", "medium", "high"), defaultReasoningEffort: "medium", serviceTiers: [{ id: "priority", name: "Fast" }] },
      { model: "fake-steady", displayName: "Fake Steady", isDefault: false, hidden: false, supportedReasoningEfforts: efforts("medium"), defaultReasoningEffort: "medium", serviceTiers: [] },
    ] } });
  }
  if (method === "thread/start" || method === "thread/resume") return send({ id, result: { thread: { id: "fake-thread" } } });
  if (method === "thread/compact/start") return compact(id);
  if (method !== "turn/start") return send({ id, result: {} });

  const turn = { id: `turn-${++turns}`, status: "inProgress" };
  send({ id, result: { turn } });
  const asked = params.input.find((part) => part.type === "text")?.text ?? "";
  const itemId = `reply-${turns}`;
  const chunks = Array.from({ length: 12 }, (_, i) => `Reply paragraph ${i} to "${asked.slice(0, 40)}", long enough to wrap across the transcript on a phone.\n\n`);
  const threadId = "fake-thread";
  notify("turn/started", { threadId, turn });
  notify("item/started", { threadId, item: { type: "agentMessage", id: itemId, text: "" } });
  let sent = 0;
  const timer = setInterval(() => {
    if (sent < chunks.length) {
      notify("item/agentMessage/delta", { threadId, itemId, delta: chunks[sent++] });
      return;
    }
    clearInterval(timer);
    usage(16_040);
    notify("item/completed", { threadId, item: { type: "agentMessage", id: itemId, text: chunks.join("") + `Reply finished.\n\nService tier: ${params.serviceTierForTurn ?? "none"}.` } });
    notify("turn/completed", { threadId, turn: { ...turn, status: "completed" } });
  }, 40);
});

function usage(totalTokens) {
  notify("thread/tokenUsage/updated", { threadId: "fake-thread", turnId: `turn-${turns}`, tokenUsage: { last: { totalTokens } } });
}

function compact(id) {
  send({ id, result: {} });
  const turn = { id: `turn-${++turns}`, status: "inProgress" };
  const threadId = "fake-thread";
  const item = { type: "contextCompaction", id: `compaction-${turns}` };
  notify("turn/started", { threadId, turn });
  notify("item/started", { threadId, turnId: turn.id, item });
  const release = join(process.env.BORKCODE_HOME ?? ".", "release-compaction");
  const timer = setInterval(() => {
    if (!existsSync(release)) return;
    clearInterval(timer);
    usage(10_011);
    notify("item/completed", { threadId, turnId: turn.id, item });
    notify("turn/completed", { threadId, turn: { ...turn, status: "completed" } });
  }, 20);
}
