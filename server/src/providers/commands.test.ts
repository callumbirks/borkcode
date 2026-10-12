import assert from "node:assert/strict";
import { test } from "node:test";
import type { SDKCompactBoundaryMessage, SDKMessage, SDKStatusMessage } from "@anthropic-ai/claude-agent-sdk";
import { commandName } from "shared/commands";
import { claudeCommands, claudeCompaction, compactSummary } from "./claude.ts";
import { CODEX_COMMANDS, isCodexCompact } from "./codex.ts";

test("Claude offers only its own commands that work headless, as it describes them", () => {
  const listed = [
    { name: "compact", description: "Free up context", argumentHint: "<optional instructions>", builtin: true },
    { name: "model", description: "Set the model", argumentHint: "<model>", builtin: true },
    { name: "simplify", description: "A bundled skill", argumentHint: "", builtin: true },
    { name: "context", description: "Show context usage", argumentHint: "", builtin: true },
    // A user's own command with a built-in name is not Claude's.
    { name: "usage", description: "My usage script", argumentHint: "" },
    { name: "deploy", description: "Project command", argumentHint: "" },
  ];
  assert.deepEqual(claudeCommands(listed), [
    { name: "compact", description: "Free up context", argumentHint: "<optional instructions>", firstMessage: false },
    { name: "context", description: "Show context usage", argumentHint: "", firstMessage: true },
  ]);
});

test("Codex offers /compact, which takes no instructions", () => {
  assert.deepEqual(CODEX_COMMANDS.map((command) => command.name), ["compact"]);
  assert.equal(isCodexCompact(" /Compact ", []), true);
  assert.equal(isCodexCompact("/compact keep the notes", []), false);
  assert.equal(isCodexCompact("/compact", [{ id: "a", name: "a.png", mimeType: "image/png", size: 1, path: "/a.png" }]), false);
});

test("a message starts with a command only when a slash and a name open it", () => {
  assert.equal(commandName("/compact"), "compact");
  assert.equal(commandName("  /Compact keep the API notes"), "compact");
  assert.equal(commandName("/context\nmore"), "context");
  assert.equal(commandName("/tmp/out.log is empty"), null);
  assert.equal(commandName("please /compact"), null);
  assert.equal(commandName("/"), null);
});

const session = { session_id: "s" };
const STATUS_ID = "00000000-0000-4000-8000-000000000001";
const BOUNDARY_ID = "00000000-0000-4000-8000-000000000002";
const status = (fields: Pick<SDKStatusMessage, "status" | "compact_result" | "compact_error">): SDKMessage => ({
  type: "system",
  subtype: "status",
  uuid: STATUS_ID,
  ...session,
  ...fields,
});
const boundary = (trigger: "manual" | "auto", post?: number): SDKCompactBoundaryMessage => ({
  type: "system",
  subtype: "compact_boundary",
  uuid: BOUNDARY_ID,
  compact_metadata: { trigger, pre_tokens: 4294, ...(post === undefined ? {} : { post_tokens: post }) },
  ...session,
});
const summary: SDKMessage = {
  type: "user",
  isSynthetic: true,
  parent_tool_use_id: null,
  uuid: "00000000-0000-4000-8000-000000000003",
  message: {
    role: "user",
    content:
      "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request: say hi.\n",
  },
  ...session,
};

test("a Claude compaction runs from its status to its boundary, then takes the summary that follows", () => {
  const running = claudeCompaction(null, status({ status: "compacting" }));
  assert.deepEqual(running, {
    id: STATUS_ID,
    kind: "compaction",
    status: "running",
    trigger: null,
    tokensBefore: null,
    tokensAfter: null,
    summary: null,
  });
  assert.equal(claudeCompaction(running!, status({ status: null, compact_result: "success" })), undefined);
  const done = claudeCompaction(running!, boundary("manual", 972));
  assert.deepEqual(done, { ...running, status: "done", trigger: "manual", tokensBefore: 4294, tokensAfter: 972 });
  const summarized = claudeCompaction(done!, summary);
  assert.equal(summarized?.summary, "1. Primary Request: say hi.");
  // Only the first synthetic message after the boundary is the summary.
  assert.equal(claudeCompaction(summarized!, summary), undefined);
});

test("an automatic Claude compaction may arrive as a boundary alone, and a failed one keeps its error", () => {
  assert.deepEqual(claudeCompaction(null, boundary("auto")), {
    id: BOUNDARY_ID,
    kind: "compaction",
    status: "done",
    trigger: "auto",
    tokensBefore: 4294,
    tokensAfter: null,
    summary: null,
  });
  const running = claudeCompaction(null, status({ status: "compacting" }))!;
  assert.deepEqual(claudeCompaction(running, status({ status: null, compact_result: "failed", compact_error: "Not enough messages" })), {
    ...running,
    status: "failed",
    error: "Not enough messages",
  });
  assert.equal(claudeCompaction(null, summary), undefined);
  assert.equal(compactSummary("no preamble here"), "no preamble here");
});
