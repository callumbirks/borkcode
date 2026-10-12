import type { Mention } from "shared/protocol";

/**
 * The `@` reference being typed at the caret, if any: an `@` at the start of the text or after
 * whitespace, followed by non-whitespace up to the caret. `start` is the index of the `@`.
 */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)@(\S*)$/.exec(before);
  if (!match) return null;
  return { start: caret - match[1].length - 1, query: match[1] };
}

/**
 * Replaces the reference being typed, including any word right after the caret, with the picked
 * one and a space, and returns the caret position after it. Categories skip the space.
 */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  reference: string,
  trailingSpace = true,
): { text: string; caret: number } {
  const end = caret + (/^\S*/.exec(text.slice(caret))?.[0].length ?? 0);
  const rest = text.slice(end);
  const inserted = !trailingSpace || rest.startsWith(" ") ? reference : `${reference} `;
  const head = text.slice(0, start) + inserted;
  return { text: head + rest, caret: head.length + (trailingSpace && rest.startsWith(" ") ? 1 : 0) };
}

/** The last segment of a path, shown as the row's title. */
export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export const THREAD_PREFIX = "thread:";

/** The typed prefix determines the mode; removing its colon returns to mixed search. */
export function mentionSearch(query: string): { mode: "mixed" | "threads"; query: string } {
  return query.toLowerCase().startsWith(THREAD_PREFIX)
    ? { mode: "threads", query: query.slice(THREAD_PREFIX.length) }
    : { mode: "mixed", query };
}

export function matchesThreadCategory(query: string): boolean {
  return "threads".startsWith(query.toLowerCase());
}

/** A category changes how the picker searches rather than referring to an agent-visible object. */
export type PickerEntry = Mention | { kind: "category"; reference: "@thread:" };

export function pickerEntries(query: string, found: Mention[]): PickerEntry[] {
  const search = mentionSearch(query);
  if (search.mode === "threads") return found.filter(m => m.kind === "thread").slice(0, 50);
  const matches = query ? found : found.filter(m => m.kind === "file");
  if (!matchesThreadCategory(query)) return matches.slice(0, 50);
  return [{ kind: "category", reference: "@thread:" }, ...matches.slice(0, 49)];
}

/** Enter thread search without a trailing space, leaving the caret immediately after the colon. */
export function enterThreadMode(text: string, start: number, caret: number): { text: string; caret: number } {
  return insertMention(text, start, caret, `@${THREAD_PREFIX}`, false);
}
