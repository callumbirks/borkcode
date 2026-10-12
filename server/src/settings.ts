import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AutoArchive, ChildModelRule, DelegationLimits, ModelChoice, Settings } from "shared/protocol";
import { isEffort } from "./providers/types.ts";

export const DEFAULT_SETTINGS: Settings = {
  titleModel: { provider: "codex", model: "gpt-6-luna", effort: "low" },
  autoCommit: true,
  networkAccess: false,
  delegation: { wakesPerWindow: 8, windowMinutes: 10, maxAutomaticTurns: 50 },
  childModelRules: [],
  autoArchive: { enabled: true, days: 7 },
};

function readDelegation(value: unknown): DelegationLimits {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const positive = (key: keyof DelegationLimits) => {
    const number = raw[key];
    return typeof number === "number" && Number.isInteger(number) && number > 0
      ? number
      : DEFAULT_SETTINGS.delegation[key];
  };
  return {
    wakesPerWindow: positive("wakesPerWindow"),
    windowMinutes: positive("windowMinutes"),
    maxAutomaticTurns: positive("maxAutomaticTurns"),
  };
}

export const MAX_AUTO_ARCHIVE_DAYS = 365;

function readAutoArchive(value: unknown): AutoArchive {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const { days } = raw;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_SETTINGS.autoArchive.enabled,
    days:
      typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= MAX_AUTO_ARCHIVE_DAYS
        ? days
        : DEFAULT_SETTINGS.autoArchive.days,
  };
}

function readModelChoice<T extends ModelChoice | null>(value: unknown, fallback: T): ModelChoice | T {
  if (!value || typeof value !== "object") return fallback;
  const { provider, model, effort } = value as Record<string, unknown>;
  if (provider !== "claude" && provider !== "codex") return fallback;
  return {
    provider,
    model: typeof model === "string" && model ? model : null,
    effort: isEffort(effort) ? effort : null,
  };
}

/** Drops rules that are malformed rather than guessing what they meant, keeping the rest in order. */
function readChildModelRules(value: unknown): ChildModelRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((rule): ChildModelRule[] => {
    if (!rule || typeof rule !== "object") return [];
    const { when, use } = rule as Record<string, unknown>;
    const parent = readModelChoice(when, null);
    const child = readModelChoice(use, null);
    if (!parent?.model || !child) return [];
    // An unknown effort would otherwise widen the rule to any effort.
    const effort = (when as Record<string, unknown>).effort;
    if (effort != null && effort !== parent.effort) return [];
    return [{ when: { provider: parent.provider, model: parent.model, effort: parent.effort }, use: child }];
  });
}

/** Keeps known keys, falling back to defaults for anything missing or malformed. */
function readSettings(raw: Record<string, unknown>): Settings {
  return {
    titleModel: readModelChoice(raw.titleModel, DEFAULT_SETTINGS.titleModel),
    autoCommit: typeof raw.autoCommit === "boolean" ? raw.autoCommit : DEFAULT_SETTINGS.autoCommit,
    networkAccess: typeof raw.networkAccess === "boolean" ? raw.networkAccess : false,
    delegation: readDelegation(raw.delegation),
    childModelRules: readChildModelRules(raw.childModelRules),
    autoArchive: readAutoArchive(raw.autoArchive),
  };
}

/** `<home>/settings.json` is read on every use, so hand edits apply without a restart. */
export class SettingsStore {
  readonly path: string;

  constructor(home: string) {
    this.path = join(home, "settings.json");
  }

  async get(): Promise<Settings> {
    if (!existsSync(this.path)) return DEFAULT_SETTINGS;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(await readFile(this.path, "utf8")) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Could not read ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return readSettings(raw);
  }

  async update(settings: Settings): Promise<Settings> {
    const next = readSettings({ ...settings });
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }
}
