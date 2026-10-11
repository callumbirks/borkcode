import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChildModelRule, ModelOption } from "shared/protocol";
import { childModelChoice, matchChildModelRule, resolveDefaults } from "./models.ts";

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
