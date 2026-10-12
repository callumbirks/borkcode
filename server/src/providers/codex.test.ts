import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
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
  let turnEnded!: (outcome: TurnOutcome) => void;
  const ended = new Promise<TurnOutcome>((resolve) => (turnEnded = resolve));
  let onClosed!: () => void;
  const closed = new Promise<void>((resolve) => (onClosed = resolve));
  const events: SessionEvents = {
    sessionId() {},
    item() {},
    delta() {},
    turnEnded(outcome) {
      outcomes.push(outcome);
      turnEnded(outcome);
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
  return { started, outcomes, ended, closed };
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
