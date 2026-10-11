import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DEFAULT_SETTINGS, SettingsStore } from "./settings.ts";

const scratch = await mkdtemp(join(tmpdir(), "borkcode-settings-"));
after(() => rm(scratch, { recursive: true, force: true }));

test("settings default until saved, then round-trip through settings.json", async () => {
  const store = new SettingsStore(join(scratch, "fresh"));
  assert.deepEqual(await store.get(), DEFAULT_SETTINGS);
  const settings = {
    titleModel: { provider: "claude" as const, model: "haiku", effort: null },
    autoCommit: false,
    delegation: { wakesPerWindow: 4, windowMinutes: 5, maxAutomaticTurns: 20 },
  };
  await store.update(settings);
  assert.deepEqual(await store.get(), settings);
  assert.deepEqual(JSON.parse(await readFile(store.path, "utf8")), settings);
});

test("hand edits with unknown values fall back field by field", async () => {
  const store = new SettingsStore(scratch);
  await writeFile(
    store.path,
    JSON.stringify({
      titleModel: { provider: "codex", model: "", effort: "ultra" },
      autoCommit: "yes",
      delegation: { wakesPerWindow: 0, windowMinutes: 2.5, maxAutomaticTurns: 30 },
    }),
  );
  assert.deepEqual(await store.get(), {
    titleModel: { provider: "codex", model: null, effort: null },
    autoCommit: true,
    delegation: { wakesPerWindow: 8, windowMinutes: 10, maxAutomaticTurns: 30 },
  });
  await writeFile(store.path, JSON.stringify({ titleModel: { provider: "gemini" } }));
  assert.deepEqual(await store.get(), DEFAULT_SETTINGS);
  await writeFile(store.path, "{ not json");
  await assert.rejects(store.get(), /Could not read/);
});
