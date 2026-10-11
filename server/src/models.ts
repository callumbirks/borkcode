import type { ChildModelRule, Effort, ModelChoice, ModelOption, ProviderKind } from "shared/protocol";
import { ToolError } from "./errors.ts";
import { generateClaudeText, listClaudeModels } from "./providers/claude.ts";
import { generateCodexText, listCodexModels } from "./providers/codex.ts";
import type { TextRequest } from "./providers/types.ts";

const listers: Record<ProviderKind, () => Promise<ModelOption[]>> = {
  claude: listClaudeModels,
  codex: listCodexModels,
};

const generators: Record<ProviderKind, (request: TextRequest) => Promise<string>> = {
  claude: generateClaudeText,
  codex: generateCodexText,
};

/** Listing starts a CLI process, so results are reused for a while. CLI updates show up after that. */
const CACHE_MS = 10 * 60_000;
const cache = new Map<ProviderKind, { at: number; models: Promise<ModelOption[]> }>();

export function listModels(provider: ProviderKind): Promise<ModelOption[]> {
  const cached = cache.get(provider);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.models;
  const models = listers[provider]();
  cache.set(provider, { at: Date.now(), models });
  models.catch(() => cache.delete(provider));
  return models;
}

/**
 * Checks a model and effort an agent asked for against the provider's own list, so a typo fails
 * with the valid names instead of starting a thread that cannot run. An inherited effort the model
 * lacks falls back to its default; an explicit one is an error. Unchecked if the list is unavailable.
 */
export async function checkModelChoice(
  provider: ProviderKind,
  model: string | null,
  effort: Effort | null,
  effortExplicit: boolean,
  lister: (provider: ProviderKind) => Promise<ModelOption[]> = listModels,
): Promise<{ model: string | null; effort: Effort | null }> {
  if (model === null && effort === null) return { model, effort };
  const list = await lister(provider).catch(() => null);
  if (!list) return { model, effort };
  const chosen = model === null ? list.find((option) => option.isDefault) : list.find((option) => option.id === model);
  if (!chosen) {
    if (model === null) return { model, effort };
    throw new ToolError(`${provider} has no model "${model}". Available: ${list.map((option) => option.id).join(", ")}.`);
  }
  if (effort && !chosen.efforts.includes(effort)) {
    if (effortExplicit) {
      throw new ToolError(`${chosen.name} supports ${chosen.efforts.join(", ") || "no effort levels"}, not ${effort}.`);
    }
    return { model, effort: null };
  }
  return { model, effort };
}

/** Names the model and effort a null choice stands for, so rules can match a parent on defaults. */
export function resolveDefaults(choice: ModelChoice, list: ModelOption[] | null): ModelChoice {
  const option = list?.find((entry) => (choice.model === null ? entry.isDefault : entry.id === choice.model));
  return {
    provider: choice.provider,
    model: choice.model ?? option?.id ?? null,
    effort: choice.effort ?? option?.defaultEffort ?? null,
  };
}

export function matchChildModelRule(rules: ChildModelRule[], parent: ModelChoice): ChildModelRule | undefined {
  return rules.find(
    ({ when }) =>
      when.provider === parent.provider &&
      when.model === parent.model &&
      (when.effort === null || when.effort === parent.effort),
  );
}

/**
 * A child's model before checking: the agent's explicit choices over a base, which is the matching
 * rule's target or else the parent's. Naming another provider than the base's drops the base's
 * model and effort, and naming a model drops its effort, since neither carries over meaningfully.
 */
export function childModelChoice(
  base: ModelChoice,
  request: { provider?: ProviderKind; model?: string; effort?: Effort },
): ModelChoice {
  const provider = request.provider ?? base.provider;
  const inherit = provider === base.provider && request.model === undefined;
  return {
    provider,
    model: request.model ?? (inherit ? base.model : null),
    effort: request.effort ?? (inherit ? base.effort : null),
  };
}

export async function generateText(
  choice: ModelChoice,
  request: Omit<TextRequest, "model" | "effort">,
): Promise<string> {
  return generators[choice.provider]({ ...request, model: choice.model, effort: choice.effort });
}
