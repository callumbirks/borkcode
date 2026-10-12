import { resolveDefaults } from "shared/models";
import type { AccessMode, Effort, ModelOption, ProviderKind } from "shared/protocol";

/**
 * The new-thread composer's last choices on this device, so the next thread starts the same way.
 * Role and workspace are left out on purpose: captains and main checkouts are deliberate each time.
 */
export interface ThreadDefaults {
  provider: ProviderKind;
  providers: Partial<Record<ProviderKind, ProviderSettings>>;
}

export interface ProviderSettings {
  model: string | null;
  effort: Effort | null;
  accessMode: AccessMode;
  fastMode: boolean;
}

export const threadDefaultsKey = "borkcode.threadDefaults";

const providers: ProviderKind[] = ["claude", "codex"];
const efforts: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const empty: ProviderSettings = { model: null, effort: null, accessMode: "ask", fastMode: false };

/** Reads what `rememberThread` saved, dropping anything malformed field by field. */
export function parseThreadDefaults(raw: string | null): ThreadDefaults {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? "null");
  } catch {
    value = null;
  }
  const record = isRecord(value) ? value : {};
  const saved = isRecord(record.providers) ? record.providers : {};
  const result: ThreadDefaults = {
    provider: providers.includes(record.provider as ProviderKind) ? (record.provider as ProviderKind) : "claude",
    providers: {},
  };
  for (const provider of providers) {
    const entry = saved[provider];
    if (!isRecord(entry)) continue;
    result.providers[provider] = {
      model: typeof entry.model === "string" && entry.model ? entry.model : null,
      effort: efforts.includes(entry.effort as Effort) ? (entry.effort as Effort) : null,
      accessMode: entry.accessMode === "full" ? "full" : "ask",
      fastMode: entry.fastMode === true,
    };
  }
  return result;
}

/** A provider's saved settings, or the provider's defaults with access asked first and fast mode off. */
export function settingsFor(defaults: ThreadDefaults, provider: ProviderKind): ProviderSettings {
  return { ...(defaults.providers[provider] ?? empty) };
}

/**
 * Names the saved choice concretely: a model the provider no longer lists becomes its default, an
 * effort the model lacks its default effort. An unavailable list leaves the choice alone, like the
 * server does.
 */
export function validChoice(
  choice: { model: string | null; effort: Effort | null },
  list: ModelOption[] | null,
): { model: string | null; effort: Effort | null } {
  if (!list || list.length === 0) return choice;
  const listed = choice.model !== null && list.some((option) => option.id === choice.model);
  return resolveDefaults({ model: listed ? choice.model : null, effort: choice.effort }, list);
}

/** Records the settings a thread was just created with as the provider's and device's defaults. */
export function rememberThread(
  defaults: ThreadDefaults,
  provider: ProviderKind,
  { model, effort, accessMode, fastMode }: ProviderSettings,
): ThreadDefaults {
  return { provider, providers: { ...defaults.providers, [provider]: { model, effort, accessMode, fastMode } } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
