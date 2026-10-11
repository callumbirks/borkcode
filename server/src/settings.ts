import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelChoice, Settings } from "shared/protocol";
import { isEffort } from "./providers/types.ts";

export const DEFAULT_SETTINGS: Settings = {
  titleModel: { provider: "codex", model: "gpt-6-luna", effort: "low" },
  autoCommit: true,
};

function readModelChoice(value: unknown, fallback: ModelChoice): ModelChoice {
  if (!value || typeof value !== "object") return fallback;
  const { provider, model, effort } = value as Record<string, unknown>;
  if (provider !== "claude" && provider !== "codex") return fallback;
  return {
    provider,
    model: typeof model === "string" && model ? model : null,
    effort: isEffort(effort) ? effort : null,
  };
}

/** Keeps known keys, falling back to defaults for anything missing or malformed. */
function readSettings(raw: Record<string, unknown>): Settings {
  return {
    titleModel: readModelChoice(raw.titleModel, DEFAULT_SETTINGS.titleModel),
    autoCommit: typeof raw.autoCommit === "boolean" ? raw.autoCommit : DEFAULT_SETTINGS.autoCommit,
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
