import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChildModelRule, ModelOption } from "shared/protocol";
import { findModel } from "shared/models";
import { checkModelChoice, childFastMode, childModelChoice, ruleFastMode, matchChildModelRule, resolveDefaults, resolveRuleModels } from "./models.ts";
import { claudeFastMode, claudeModelOptions } from "./providers/claude.ts";

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
    { id: "sonnet-5-5", name: "Sonnet 5.5", isDefault: false, efforts: ["low", "high"], defaultEffort: "high", supportsFastMode: false },
    { id: "opus-5-5", name: "Opus 5.5", isDefault: true, efforts: ["medium", "xhigh"], defaultEffort: "xhigh", supportsFastMode: false },
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
    { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "", supportsEffort: true, supportedEffortLevels: [...efforts], supportsFastMode: true },
    { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "", supportsEffort: true, supportedEffortLevels: ["low", "medium"] },
    { value: "claude-haiku-4-5", resolvedModel: "claude-haiku-4-5", displayName: "Haiku 4.5", description: "" },
  ]);
  assert.deepEqual(
    options.map(({ id, isDefault, defaultEffort, supportsFastMode }) => [id, isDefault, defaultEffort, supportsFastMode]),
    [
      ["claude-opus-5-5", false, null, false],
      ["opus", true, "high", true],
      ["sonnet", false, "medium", false],
      ["claude-haiku-4-5", false, null, false],
    ],
  );
  assert.equal(options.find((option) => option.id === "opus")?.resolvedModel, "claude-opus-5-5");
});

const claudeList: ModelOption[] = [
  { id: "opus", name: "Opus 5.5", resolvedModel: "claude-opus-5-5", isDefault: true, efforts: ["high", "max"], defaultEffort: "high", supportsFastMode: true },
  { id: "fable", name: "Fable 5.1", resolvedModel: "claude-fable-5-1", isDefault: false, efforts: ["high"], defaultEffort: "high", supportsFastMode: false },
  { id: "claude-opus-5", name: "Opus 5", resolvedModel: "claude-opus-5", isDefault: false, efforts: ["high"], defaultEffort: "high", supportsFastMode: false },
];
const check = (model: string | null, list = claudeList) => checkModelChoice("claude", model, null, false, async () => list);

test("a full model id an alias resolves to is stored as the alias", async () => {
  assert.deepEqual(await check("claude-opus-5-5"), { model: "opus", effort: null });
  assert.deepEqual(await check("claude-fable-5-1"), { model: "fable", effort: null });
  assert.deepEqual(await check("claude-opus-5"), { model: "claude-opus-5", effort: null });
  assert.deepEqual(resolveDefaults({ model: "claude-opus-5-5", effort: null }, claudeList), { model: "opus", effort: "high" });
});

test("a pinned id is kept when listed, even if an alias resolves to it", async () => {
  const pinned: ModelOption = { ...claudeList[0]!, id: "claude-opus-5-5", name: "Opus 5.5 (pinned)", isDefault: false };
  assert.deepEqual(await check("claude-opus-5-5", [...claudeList, pinned]), { model: "claude-opus-5-5", effort: null });
  assert.deepEqual(await check("opus", [...claudeList, pinned]), { model: "opus", effort: null });
});

test("an unknown model fails, naming each listed model", async () => {
  for (const model of ["claude-opus-5.5", "Opus 5.5"]) {
    await assert.rejects(check(model), {
      message: `claude has no model "${model}". Available: opus (Opus 5.5), fable (Fable 5.1), claude-opus-5 (Opus 5).`,
    });
  }
});

test("null, Claude's old \"default\" and efforts a model lacks resolve to concrete names", () => {
  const list: ModelOption[] = [
    { id: "opus", name: "Opus 5.5", isDefault: true, efforts: ["medium", "high"], defaultEffort: "high", supportsFastMode: false },
    { id: "haiku", name: "Haiku", isDefault: false, efforts: [], defaultEffort: null, supportsFastMode: false },
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
  const list: ModelOption[] = [{ id: "opus", name: "Opus 5.5", isDefault: true, efforts: [], defaultEffort: null, supportsFastMode: false }];
  const saved: ChildModelRule[] = [
    { when: { provider: "claude", model: "default", effort: null }, use: { provider: "codex", model: null, effort: "high" } },
  ];
  const resolved = resolveRuleModels(saved, "claude", list);
  assert.equal(resolved[0]!.when.model, "opus");
  assert.equal(matchChildModelRule(resolved, { provider: "claude", model: "opus", effort: null }), resolved[0]);
  assert.equal(resolveRuleModels(saved, "claude", null), saved);
});

test("Claude's fast mode is its fastMode flag setting, set off explicitly too", () => {
  assert.deepEqual(claudeFastMode(true), { fastMode: true });
  assert.deepEqual(claudeFastMode(false), { fastMode: false });
});

test("a rule's fast mode decides a child's, else the parent's, never on a model without it", () => {
  for (const parent of [false, true]) {
    assert.equal(childFastMode("on", parent, true), true);
    assert.equal(childFastMode("off", parent, true), false);
    assert.equal(childFastMode("inherit", parent, true), parent);
    // Rules saved before they could set fast mode inherit.
    assert.equal(childFastMode(undefined, parent, true), parent);
    assert.equal(childFastMode("on", parent, false), false);
    assert.equal(childFastMode(undefined, parent, false), false);
  }
  // With no model list, the provider decides.
  assert.equal(childFastMode("on", false, null), true);
  assert.equal(childFastMode(undefined, true, null), true);
});

test("a rule's fast mode applies only while the child runs on the rule's model", () => {
  const claude: ModelOption[] = [
    { id: "opus", name: "Opus 5.5", isDefault: true, efforts: ["medium", "high"], defaultEffort: "high", supportsFastMode: true, resolvedModel: "claude-opus-5-5" },
  ];
  const codex: ModelOption[] = [
    { id: "gpt-6.1-sol", name: "GPT 6.1 Sol", isDefault: true, efforts: ["low", "high"], defaultEffort: "low", supportsFastMode: true },
  ];
  const rule: ChildModelRule = {
    when: { provider: "codex", model: "gpt-6-astra", effort: null },
    use: { provider: "codex", model: "gpt-6.1-sol", effort: "high", fastMode: "on" },
  };
  // As start_thread decides it: the rule's use, the agent's choices over it, the parent's fast mode.
  const decide = (request: Parameters<typeof childModelChoice>[1], parentFastMode: boolean, use = rule.use) => {
    const child = childModelChoice(use, request);
    const list = child.provider === "claude" ? claude : codex;
    const option = findModel(list, child.model);
    return childFastMode(ruleFastMode(use, resolveDefaults(child, list), list), parentFastMode, option?.supportsFastMode ?? false);
  };
  // The agent replaced the rule's provider and model: the child inherits the parent's off.
  assert.equal(decide({ provider: "claude", model: "opus", effort: "medium" }, false), false);
  // ...or its on, where the model offers fast mode, by alias or full id.
  assert.equal(decide({ provider: "claude", model: "opus", effort: "medium" }, true), true);
  assert.equal(decide({ provider: "claude", model: "claude-opus-5-5" }, true), true);
  // Only the effort changed: still the rule's model, so its on or off holds.
  assert.equal(decide({ effort: "low" }, false), true);
  assert.equal(decide({ effort: "low" }, true, { ...rule.use, fastMode: "off" }), false);
  // No explicit choice: the rule applies as before.
  assert.equal(decide({}, false), true);
  assert.equal(decide({}, true, { ...rule.use, fastMode: "off" }), false);
  // An alias in the rule and the full id it resolves to are the same model.
  const claudeRule = { provider: "claude" as const, model: "claude-opus-5-5", effort: null, fastMode: "off" as const };
  assert.equal(ruleFastMode(claudeRule, { provider: "claude", model: "opus", effort: "high" }, claude), "off");
  assert.equal(ruleFastMode(undefined, { provider: "claude", model: "opus", effort: "high" }, claude), undefined);
});
