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
    networkAccess: false,
    delegation: { wakesPerWindow: 4, windowMinutes: 5, maxAutomaticTurns: 20 },
    childModelRules: [
      {
        when: { provider: "claude" as const, model: "opus-5-5", effort: "xhigh" as const },
        use: { provider: "claude" as const, model: "opus-5-5", effort: "medium" as const },
      },
    ],
    autoArchive: { enabled: false, days: 30 },
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
      childModelRules: [
        { when: { provider: "claude", model: "opus-5-5" }, use: { provider: "codex", model: "gpt-6.1-sol", effort: "high" } },
        { when: { provider: "claude" }, use: { provider: "codex" } },
        { when: { provider: "codex", model: "gpt-6-astra", effort: "ultra" }, use: { provider: "codex" } },
        { when: { provider: "codex", model: "gpt-6-astra" }, use: { provider: "gemini" } },
        "not a rule",
        { when: { provider: "codex", model: "gpt-6-astra", effort: null }, use: { provider: "codex", model: 7 } },
      ],
    }),
  );
  assert.deepEqual(await store.get(), {
    titleModel: { provider: "codex", model: null, effort: null },
    autoCommit: true,
    networkAccess: false,
    delegation: { wakesPerWindow: 8, windowMinutes: 10, maxAutomaticTurns: 30 },
    childModelRules: [
      {
        when: { provider: "claude", model: "opus-5-5", effort: null },
        use: { provider: "codex", model: "gpt-6.1-sol", effort: "high" },
      },
      {
        when: { provider: "codex", model: "gpt-6-astra", effort: null },
        use: { provider: "codex", model: null, effort: null },
      },
    ],
    autoArchive: { enabled: true, days: 7 },
  });
  await writeFile(store.path, JSON.stringify({ autoCommit: false, childModelRules: { not: "a list" } }));
  assert.deepEqual(await store.get(), { ...DEFAULT_SETTINGS, autoCommit: false });
  await writeFile(store.path, JSON.stringify({ titleModel: { provider: "gemini" } }));
  assert.deepEqual(await store.get(), DEFAULT_SETTINGS);
  await writeFile(store.path, "{ not json");
  await assert.rejects(store.get(), /Could not read/);
});

test("a rule's fast mode is kept when on or off, and anything else means inherit", async () => {
  const store = new SettingsStore(join(scratch, "rule-fast"));
  await store.update(DEFAULT_SETTINGS);
  const rule = (fastMode?: unknown) => ({
    when: { provider: "claude", model: "opus", effort: null },
    use: { provider: "claude", model: "opus", effort: "low", ...(fastMode === undefined ? {} : { fastMode }) },
  });
  await writeFile(store.path, JSON.stringify({ childModelRules: [rule("on"), rule("off"), rule(), rule("inherit"), rule("turbo")] }));
  assert.deepEqual(
    (await store.get()).childModelRules.map((each) => each.use.fastMode),
    ["on", "off", undefined, undefined, undefined],
  );
});

test("network access is opt-in and persists in settings.json", async () => {
  const store = new SettingsStore(join(scratch, "network"));
  const enabled = await store.update({ ...DEFAULT_SETTINGS, networkAccess: true });
  assert.equal(enabled.networkAccess, true);
  assert.equal((await store.get()).networkAccess, true);
  await store.update({ ...enabled, networkAccess: false });
  assert.equal((await store.get()).networkAccess, false);
});

test("automatic archiving is on for 7 days by default, and bad days fall back without touching the rest", async () => {
  const store = new SettingsStore(join(scratch, "archive"));
  assert.deepEqual((await store.get()).autoArchive, { enabled: true, days: 7 });
  await store.update(DEFAULT_SETTINGS);
  for (const days of [0, -3, 366, 2.5, "14", null]) {
    await writeFile(store.path, JSON.stringify({ autoCommit: false, autoArchive: { enabled: false, days } }));
    assert.deepEqual(await store.get(), { ...DEFAULT_SETTINGS, autoCommit: false, autoArchive: { enabled: false, days: 7 } });
  }
  await writeFile(store.path, JSON.stringify({ autoArchive: "yes" }));
  assert.deepEqual((await store.get()).autoArchive, { enabled: true, days: 7 });
  const saved = await store.update({ ...DEFAULT_SETTINGS, autoArchive: { enabled: true, days: 365 } });
  assert.deepEqual(saved.autoArchive, { enabled: true, days: 365 });
  assert.deepEqual((await store.get()).autoArchive, { enabled: true, days: 365 });
  const clamped = await store.update({ ...DEFAULT_SETTINGS, autoArchive: { enabled: true, days: 1000 } });
  assert.deepEqual(clamped.autoArchive, { enabled: true, days: 7 });
});
