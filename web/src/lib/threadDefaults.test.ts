import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelOption } from "shared/protocol";
import { parseThreadDefaults, rememberThread, settingsFor, validChoice } from "./threadDefaults.ts";

const list: ModelOption[] = [
  { id: "sonnet", name: "Sonnet", isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: "high" },
  { id: "opus", name: "Opus", isDefault: false, efforts: ["low", "medium", "high", "max"], defaultEffort: "high" },
  { id: "haiku", name: "Haiku", isDefault: false, efforts: [], defaultEffort: null },
];

test("nothing saved starts with Claude, default model and effort, and asks first", () => {
  const defaults = parseThreadDefaults(null);
  assert.equal(defaults.provider, "claude");
  assert.deepEqual(settingsFor(defaults, "claude"), { model: null, effort: null, accessMode: "ask" });
  assert.deepEqual(settingsFor(defaults, "codex"), { model: null, effort: null, accessMode: "ask" });
});

test("a created thread's settings come back per provider after a reload", () => {
  let defaults = parseThreadDefaults(null);
  defaults = rememberThread(defaults, "codex", { model: "gpt", effort: "low", accessMode: "ask" });
  defaults = rememberThread(defaults, "claude", { model: "opus", effort: "medium", accessMode: "full" });
  const reloaded = parseThreadDefaults(JSON.stringify(defaults));
  assert.equal(reloaded.provider, "claude");
  assert.deepEqual(settingsFor(reloaded, "claude"), { model: "opus", effort: "medium", accessMode: "full" });
  assert.deepEqual(settingsFor(reloaded, "codex"), { model: "gpt", effort: "low", accessMode: "ask" });
});

test("only provider, model, effort and access are kept", () => {
  const defaults = rememberThread(parseThreadDefaults(null), "claude", {
    model: "opus",
    effort: "max",
    accessMode: "full",
    captain: true,
    isolated: false,
  } as never);
  assert.doesNotMatch(JSON.stringify(defaults), /captain|isolated/);
});

test("malformed storage falls back field by field", () => {
  assert.deepEqual(parseThreadDefaults("{not json"), { provider: "claude", providers: {} });
  assert.deepEqual(parseThreadDefaults("[]"), { provider: "claude", providers: {} });
  const defaults = parseThreadDefaults(
    JSON.stringify({ provider: "gemini", providers: { claude: { model: 3, effort: "huge", accessMode: "yolo" }, codex: "x" } }),
  );
  assert.equal(defaults.provider, "claude");
  assert.deepEqual(defaults.providers, { claude: { model: null, effort: null, accessMode: "ask" } });
});

test("a saved choice is named concretely: a model the provider no longer lists becomes its default", () => {
  assert.deepEqual(validChoice({ model: "opus", effort: "max" }, list), { model: "opus", effort: "max" });
  assert.deepEqual(validChoice({ model: "retired", effort: "medium" }, list), { model: "sonnet", effort: "medium" });
  assert.deepEqual(validChoice({ model: "retired", effort: "max" }, list), { model: "sonnet", effort: "high" });
});

test("defaults saved as null, or as Claude's old \"default\", show as the default model and its effort", () => {
  assert.deepEqual(validChoice({ model: null, effort: null }, list), { model: "sonnet", effort: "high" });
  assert.deepEqual(validChoice({ model: "default", effort: "low" }, list), { model: "sonnet", effort: "low" });
});

test("an effort the model doesn't support falls back to its default", () => {
  assert.deepEqual(validChoice({ model: null, effort: "max" }, list), { model: "sonnet", effort: "high" });
  assert.deepEqual(validChoice({ model: "haiku", effort: "low" }, list), { model: "haiku", effort: null });
});

test("an unavailable model list leaves the saved choice alone", () => {
  assert.deepEqual(validChoice({ model: "opus", effort: "max" }, null), { model: "opus", effort: "max" });
  assert.deepEqual(validChoice({ model: "opus", effort: "max" }, []), { model: "opus", effort: "max" });
});
