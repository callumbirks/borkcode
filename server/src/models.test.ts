import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChildModelRule, ModelOption } from "shared/protocol";
import { childModelChoice, matchChildModelRule, resolveDefaults, resolveRuleModels } from "./models.ts";
import { claudeModelOptions } from "./providers/claude.ts";

const rules: ChildModelRule[] = [
  {
    when: { provider: "claude", model: "opus-5-5", effort: "xhigh" },
    use: { provider: "claude", model: "opus-5-5", effort: "medium" },
  },
  {
    when: { provider: "codex", model: "gpt-6-astra", effort: null },
    use: { provider: "codex", model: "gpt-6.1-sol", effort: "high" },
  },
  {
    when: { provider: "codex", model: "gpt-6-astra", effort: "low" },
    use: { provider: "claude", model: "haiku", effort: null },
  },
];

test("a rule matches on provider and model, and on effort only when it names one", () => {
  assert.equal(matchChildModelRule(rules, { provider: "claude", model: "opus-5-5", effort: "xhigh" }), rules[0]);
  assert.equal(matchChildModelRule(rules, { provider: "claude", model: "opus-5-5", effort: "high" }), undefined);
  assert.equal(matchChildModelRule(rules, { provider: "codex", model: "gpt-6-astra", effort: "max" }), rules[1]);
  // Rules apply in order, so the later, more specific rule never wins here.
  assert.equal(matchChildModelRule(rules, { provider: "codex", model: "gpt-6-astra", effort: "low" }), rules[1]);
  assert.equal(matchChildModelRule(rules, { provider: "claude", model: "gpt-6-astra", effort: null }), undefined);
});

test("a parent on defaults matches by the default model's name and effort", () => {
  const list: ModelOption[] = [
    { id: "sonnet-5-5", name: "Sonnet 5.5", isDefault: false, efforts: ["low", "high"], defaultEffort: "high" },
    { id: "opus-5-5", name: "Opus 5.5", isDefault: true, efforts: ["medium", "xhigh"], defaultEffort: "xhigh" },
  ];
  const parent = resolveDefaults({ provider: "claude", model: null, effort: null }, list);
  assert.deepEqual(parent, { provider: "claude", model: "opus-5-5", effort: "xhigh" });
  assert.equal(matchChildModelRule(rules, parent), rules[0]);
  assert.deepEqual(resolveDefaults({ provider: "claude", model: "sonnet-5-5", effort: "low" }, list), {
    provider: "claude",
    model: "sonnet-5-5",
    effort: "low",
  });
  assert.deepEqual(resolveDefaults({ provider: "claude", model: null, effort: null }, null), {
    provider: "claude",
    model: null,
    effort: null,
  });
});

test("explicit choices layer over the base the same way they did over the parent", () => {
  const base = { provider: "codex" as const, model: "gpt-6.1-sol", effort: "high" as const };
  assert.deepEqual(childModelChoice(base, {}), base);
  assert.deepEqual(childModelChoice(base, { effort: "low" }), { ...base, effort: "low" });
  assert.deepEqual(childModelChoice(base, { model: "gpt-6-luna" }), { provider: "codex", model: "gpt-6-luna", effort: null });
  assert.deepEqual(childModelChoice(base, { provider: "codex" }), base);
  assert.deepEqual(childModelChoice(base, { provider: "claude" }), { provider: "claude", model: null, effort: null });
  assert.deepEqual(childModelChoice(base, { provider: "claude", effort: "max" }), {
    provider: "claude",
    model: null,
    effort: "max",
  });
});

test("Claude's default pseudo-model is left out, and the model it stands for is the default", () => {
  const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
  const options = claudeModelOptions([
    { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "", supportsEffort: true, supportedEffortLevels: [...efforts] },
    { value: "claude-opus-5-5", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5 (pinned)", description: "" },
    { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "", supportsEffort: true, supportedEffortLevels: [...efforts] },
    { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "", supportsEffort: true, supportedEffortLevels: ["low", "medium"] },
    { value: "claude-haiku-4-5", resolvedModel: "claude-haiku-4-5", displayName: "Haiku 4.5", description: "" },
  ]);
  assert.deepEqual(
    options.map(({ id, isDefault, defaultEffort }) => [id, isDefault, defaultEffort]),
    [
      ["claude-opus-5-5", false, null],
      ["opus", true, "high"],
      ["sonnet", false, "medium"],
      ["claude-haiku-4-5", false, null],
    ],
  );
});

test("null, Claude's old \"default\" and efforts a model lacks resolve to concrete names", () => {
  const list: ModelOption[] = [
    { id: "opus", name: "Opus 5.5", isDefault: true, efforts: ["medium", "high"], defaultEffort: "high" },
    { id: "haiku", name: "Haiku", isDefault: false, efforts: [], defaultEffort: null },
  ];
  const resolve = (model: string | null, effort: "medium" | "max" | null) =>
    resolveDefaults({ provider: "claude", model, effort }, list);
  assert.deepEqual(resolve(null, null), { provider: "claude", model: "opus", effort: "high" });
  assert.deepEqual(resolve("default", "medium"), { provider: "claude", model: "opus", effort: "medium" });
  assert.deepEqual(resolve("opus", "max"), { provider: "claude", model: "opus", effort: "high" });
  assert.deepEqual(resolve("haiku", null), { provider: "claude", model: "haiku", effort: null });
  // A model the provider stopped listing is left for the provider to judge.
  assert.deepEqual(resolve("retired", "max"), { provider: "claude", model: "retired", effort: "max" });
  // With no list marking a default, the first model stands in.
  assert.equal(resolveDefaults({ provider: "codex", model: null, effort: null }, [list[1]!]).model, "haiku");
});

test("a rule saved on Claude's old default model matches a parent on the default", () => {
  const list: ModelOption[] = [{ id: "opus", name: "Opus 5.5", isDefault: true, efforts: [], defaultEffort: null }];
  const saved: ChildModelRule[] = [
    { when: { provider: "claude", model: "default", effort: null }, use: { provider: "codex", model: null, effort: "high" } },
  ];
  const resolved = resolveRuleModels(saved, "claude", list);
  assert.equal(resolved[0]!.when.model, "opus");
  assert.equal(matchChildModelRule(resolved, { provider: "claude", model: "opus", effort: null }), resolved[0]);
  assert.equal(resolveRuleModels(saved, "claude", null), saved);
});
