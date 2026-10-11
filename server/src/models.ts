import type { ModelChoice, ModelOption, ProviderKind } from "shared/protocol";
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

export async function generateText(
  choice: ModelChoice,
  request: Omit<TextRequest, "model" | "effort">,
): Promise<string> {
  return generators[choice.provider]({ ...request, model: choice.model, effort: choice.effort });
}
