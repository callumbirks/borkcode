#!/usr/bin/env node
// Stands in for `codex app-server` in the browser tests, so sending a message runs a real turn
// through the server without a provider. Each turn streams a short reply in deltas.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const notify = (method, params) => send({ method, params });
let turns = 0;

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "model/list") {
    return send({ id, result: { nextCursor: null, data: [{ model: "fake", displayName: "Fake", isDefault: true, hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "medium" }], defaultReasoningEffort: "medium" }] } });
  }
  if (method === "thread/start" || method === "thread/resume") return send({ id, result: { thread: { id: "fake-thread" } } });
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
    notify("item/completed", { threadId, item: { type: "agentMessage", id: itemId, text: chunks.join("") + "Reply finished." } });
    notify("turn/completed", { threadId, turn: { ...turn, status: "completed" } });
  }, 40);
});
