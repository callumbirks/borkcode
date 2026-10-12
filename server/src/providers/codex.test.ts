import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Item } from "shared/protocol";
import { codexModelOption, codexServiceTier, startCodexSession } from "./codex.ts";
import type { SessionEvents, TurnOutcome } from "./types.ts";

const dir = mkdtempSync(join(tmpdir(), "borkcode-codex-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function fakeCodex(name: string, script: string): string {
  const path = join(dir, name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

function session(bin: string) {
  process.env.BORKCODE_CODEX_BIN = bin;
  const outcomes: TurnOutcome[] = [];
  const items: Item[] = [];
  const endWaiters: ((outcome: TurnOutcome) => void)[] = [];
  /** Resolves when the next turn ends. */
  const nextEnd = () => new Promise<TurnOutcome>((resolve) => endWaiters.push(resolve));
  let turnEnded!: (outcome: TurnOutcome) => void;
  const ended = new Promise<TurnOutcome>((resolve) => (turnEnded = resolve));
  let onClosed!: () => void;
  const closed = new Promise<void>((resolve) => (onClosed = resolve));
  const events: SessionEvents = {
    sessionId() {},
    item: (item) => items.push(item),
    delta() {},
    turnEnded(outcome) {
      outcomes.push(outcome);
      turnEnded(outcome);
      for (const resolve of endWaiters.splice(0)) resolve(outcome);
    },
    closed: () => onClosed(),
    approval: async () => false,
    question: async () => null,
  };
  const started = startCodexSession({
    cwd: dir,
    writableRoots: [],
    instructions: "",
    accessMode: "ask",
    model: null,
    effort: null,
    fastMode: false,
    mcpUrl: "http://127.0.0.1:1/mcp/test",
    resumeId: null,
    events,
  });
  return { started, outcomes, items, ended, closed, nextEnd };
}

test("a Codex binary that exits at once fails the session, not the server", async () => {
  const { started } = session(fakeCodex("exits", "#!/bin/sh\necho 'no login' >&2\nexit 1\n"));
  await assert.rejects(started, { message: "Codex exited (code 1)\nno login" });
});

test("a missing Codex binary fails the session", async () => {
  const { started } = session(join(dir, "missing"));
  await assert.rejects(started, /^Error: Could not start Codex: spawn .* ENOENT$/);
});

test("Codex dying mid-session fails the turn and closes the session", async () => {
  // Answers the handshake, then dies when asked for a turn.
  const bin = fakeCodex(
    "dies-on-turn",
    `#!${process.execPath}
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (method === "turn/start") {
    process.stderr.write("crashed", () => process.exit(3));
  } else if (id !== undefined) {
    process.stdout.write(JSON.stringify({ id, result: { thread: { id: "t1" } } }) + "\\n");
  }
});
`,
  );
  const { started, outcomes, ended, closed } = session(bin);
  const open = await started;
  await open.sendTurn("hi", { model: null, effort: null, accessMode: "ask", fastMode: false }, []);
  assert.deepEqual(await ended, { status: "failed", error: "Codex exited (code 3)\ncrashed" });
  await closed;
  // A turn sent to the dead process fails at once rather than hanging or writing to a broken pipe.
  await open.sendTurn("again", { model: null, effort: null, accessMode: "ask", fastMode: false }, []);
  assert.deepEqual(outcomes.at(-1), { status: "failed", error: "Codex exited (code 3)\ncrashed" });
});

test("Codex fast mode is the priority service tier, asked for or turned off on every turn", () => {
  const model = {
    model: "gpt-6.1-sol",
    displayName: "GPT 6.1 Sol",
    hidden: false,
    isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "turbo" }],
    defaultReasoningEffort: "low",
  };
  assert.deepEqual(codexModelOption({ ...model, serviceTiers: [{ id: "priority", name: "Fast" }] }), {
    id: "gpt-6.1-sol",
    name: "GPT 6.1 Sol",
    isDefault: true,
    efforts: ["low"],
    defaultEffort: "low",
    supportsFastMode: true,
  });
  assert.equal(codexModelOption({ ...model, serviceTiers: [] }).supportsFastMode, false);
  assert.equal(codexModelOption(model).supportsFastMode, false);
  assert.equal(codexServiceTier(true), "priority");
  assert.equal(codexServiceTier(false), "default");
});

test("each turn asks Codex for the service tier its fast mode stands for", async () => {
  const log = join(dir, "turns.jsonl");
  // Records each turn/start and finishes the turn at once.
  const bin = fakeCodex(
    "records-turns",
    `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "turn/start") {
    appendFileSync(${JSON.stringify(log)}, JSON.stringify(params) + "\\n");
    send({ id, result: { turn: { id: "turn", status: "inProgress", error: null } } });
    send({ method: "turn/completed", params: { threadId: "t1", turn: { id: "turn", status: "completed", error: null } } });
  } else if (id !== undefined) {
    send({ id, result: { thread: { id: "t1" } } });
  }
});
`,
  );
  const { started, outcomes } = session(bin);
  const open = await started;
  await open.sendTurn("fast", { model: "gpt-6.1-sol", effort: "low", accessMode: "ask", fastMode: true }, []);
  await open.sendTurn("standard", { model: "gpt-6.1-sol", effort: "low", accessMode: "ask", fastMode: false }, []);
  const turns = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(turns.map((turn) => turn.serviceTierForTurn), ["priority", "default"]);
  assert.ok(outcomes.every((outcome) => outcome.status === "completed"));
  open.close();
});

/** A fake app-server that answers turns at once and compacts as Codex does, reporting context sizes. */
function compactingCodex(log: string) {
  return fakeCodex(
    "compacts",
    `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const notify = (method, params) => send({ method, params: { threadId: "t1", ...params } });
const usage = (totalTokens) => notify("thread/tokenUsage/updated", { turnId: "turn", tokenUsage: { last: { totalTokens } } });
const compaction = (method) => notify(method, { turnId: "turn", item: { type: "contextCompaction", id: "c1" } });
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  appendFileSync(${JSON.stringify(log)}, method + "\\n");
  if (method === "turn/start") {
    send({ id, result: { turn: { id: "turn", status: "inProgress", error: null } } });
    usage(16040);
    // A long turn's context fills up and Codex compacts it by itself.
    if (params.input[0].text === "fill up") {
      compaction("item/started");
      usage(9000);
      compaction("item/completed");
    }
    notify("turn/completed", { turn: { id: "turn", status: "completed", error: null } });
  } else if (method === "thread/compact/start") {
    send({ id, result: {} });
    notify("turn/started", { turn: { id: "turn", status: "inProgress", error: null } });
    compaction("item/started");
    usage(10011);
    compaction("item/completed");
    notify("turn/completed", { turn: { id: "turn", status: "completed", error: null } });
  } else {
    send({ id, result: { thread: { id: "t1" } } });
  }
});
`,
  );
}

test("/compact runs Codex's compaction as a turn, recorded with the context's size before and after", async () => {
  const log = join(dir, "compact.log");
  const { started, outcomes, items, nextEnd } = session(compactingCodex(log));
  const open = await started;
  const settings = { model: null, effort: null, accessMode: "ask" as const, fastMode: false };
  const turn = async (text: string) => {
    const ended = nextEnd();
    await open.sendTurn(text, settings, []);
    await ended;
  };
  try {
    await turn("hi");
    await turn("/compact");
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").slice(-2), ["turn/start", "thread/compact/start"]);
    assert.deepEqual(items.at(-1), {
      id: "c1",
      kind: "compaction",
      status: "done",
      trigger: "manual",
      tokensBefore: 16040,
      tokensAfter: 10011,
      summary: null,
    });
    assert.equal(items.find((item) => item.kind === "compaction")?.status, "running");
    assert.ok(outcomes.every((outcome) => outcome.status === "completed"));

    // Codex compacts by itself when a turn fills the context; /compact with more text is a message.
    await turn("fill up");
    assert.equal((items.at(-1) as Extract<Item, { kind: "compaction" }>).trigger, "auto");
    await turn("/compact but keep the notes");
    assert.equal(readFileSync(log, "utf8").trim().split("\n").at(-1), "turn/start");
  } finally {
    open.close();
  }
});

test("a Codex compaction that never finishes is failed when its turn ends", async () => {
  const bin = fakeCodex(
    "compaction-fails",
    `#!${process.execPath}
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const notify = (method, params) => send({ method, params: { threadId: "t1", ...params } });
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "thread/compact/start") {
    send({ id, result: {} });
    notify("turn/started", { turn: { id: "turn", status: "inProgress", error: null } });
    notify("item/started", { turnId: "turn", item: { type: "contextCompaction", id: "c1" } });
    notify("turn/completed", { turn: { id: "turn", status: "failed", error: { message: "context too large" } } });
  } else {
    send({ id, result: { thread: { id: "t1" } } });
  }
});
`,
  );
  const { started, items, ended } = session(bin);
  const open = await started;
  try {
    await open.sendTurn("/compact", { model: null, effort: null, accessMode: "ask", fastMode: false }, []);
    assert.deepEqual(await ended, { status: "failed", error: "context too large" });
    const last = items.at(-1);
    assert.equal(last?.kind === "compaction" && last.status, "failed");
    assert.equal(last?.kind === "compaction" && last.error, "context too large");
  } finally {
    open.close();
  }
});
