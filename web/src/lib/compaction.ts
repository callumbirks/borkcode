import type { Item, TranscriptItem } from "shared/protocol";

type Compaction = Extract<Item, { kind: "compaction" }>;

/** Token counts as the providers' own UIs show them, such as 972, 4.3k or 1.2M. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${+(tokens / 1000).toFixed(1)}k`;
  return `${+(tokens / 1_000_000).toFixed(1)}M`;
}

/**
 * The marker's line: what happened, then whatever the provider reported. A compaction still
 * running in a thread that no longer works was cut off, as by a server restart.
 */
export function compactionLabel(item: Compaction, threadRunning: boolean): { title: string; details: string[] } {
  if (item.status === "running") {
    return threadRunning ? { title: "Compacting context…", details: [] } : { title: "Compaction did not finish", details: [] };
  }
  if (item.status === "failed") return { title: "Compaction failed", details: item.error ? [item.error] : [] };
  const tokens =
    item.tokensBefore !== null && item.tokensAfter !== null
      ? `${formatTokens(item.tokensBefore)} → ${formatTokens(item.tokensAfter)} tokens`
      : item.tokensBefore !== null
        ? `from ${formatTokens(item.tokensBefore)} tokens`
        : null;
  return {
    title: "Context compacted",
    details: [item.trigger === "auto" ? "automatically" : item.trigger, tokens].filter((detail) => detail !== null),
  };
}

/** The current turn is compacting: checks back only to the turn's opening message, so it stays cheap. */
export function isCompacting(items: TranscriptItem[]): boolean {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (item.kind === "compaction") return item.status === "running";
    if (item.kind === "user") return false;
  }
  return false;
}
