import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { startCodexSession } from "./codex.ts";
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
  await open.sendTurn("hi", { model: null, effort: null, accessMode: "ask" }, []);
  assert.deepEqual(await ended, { status: "failed", error: "Codex exited (code 3)\ncrashed" });
  await closed;
  // A turn sent to the dead process fails at once rather than hanging or writing to a broken pipe.
  await open.sendTurn("again", { model: null, effort: null, accessMode: "ask" }, []);
  assert.deepEqual(outcomes.at(-1), { status: "failed", error: "Codex exited (code 3)\ncrashed" });
});
