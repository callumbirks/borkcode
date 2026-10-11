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
 * one and a space, and returns the caret position after it.
 */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  reference: string,
): { text: string; caret: number } {
  const end = caret + (/^\S*/.exec(text.slice(caret))?.[0].length ?? 0);
  const rest = text.slice(end);
  const inserted = rest.startsWith(" ") ? reference : `${reference} `;
  const head = text.slice(0, start) + inserted;
  return { text: head + rest, caret: head.length + (rest.startsWith(" ") ? 1 : 0) };
}

/** The last segment of a path, shown as the row's title. */
export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
