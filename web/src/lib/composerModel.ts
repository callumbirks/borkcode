import type { FileReference } from "./fileReferences.ts";

export interface Snapshot {
  text: string;
  caret: number;
}

/** Replaces `text[start, end)`, leaving the caret after what was inserted. */
export function replaceRange(text: string, start: number, end: number, insert: string): Snapshot {
  return { text: text.slice(0, start) + insert + text.slice(end), caret: start + insert.length };
}

/** Chips are atomic: a range that cuts into one grows to cover it. */
export function coverReferences(start: number, end: number, references: FileReference[]): [number, number] {
  for (const reference of references) {
    if (reference.start < end && reference.end > start) {
      start = Math.min(start, reference.start);
      end = Math.max(end, reference.end);
    }
  }
  return [start, end];
}

/** Backspace right after a chip, or Delete right before one, removes the whole reference. */
export function chipBeside(caret: number, backward: boolean, references: FileReference[]): [number, number] | null {
  const reference = references.find((each) => (backward ? each.end === caret : each.start === caret));
  return reference ? [reference.start, reference.end] : null;
}

/** Typing within this long of the last keystroke undoes together with it. */
const COALESCE_MS = 1000;

/**
 * The composer's own undo stack. Edits are applied to the text and the DOM is redrawn, so the
 * browser's history can't follow them.
 */
export class History {
  #undo: Snapshot[] = [];
  #redo: Snapshot[] = [];
  #lastKind: string | null = null;
  #lastAt = 0;

  /** Call before an edit with the state it changes. Runs of typing collapse into one step. */
  record(before: Snapshot, kind: string, now: number): void {
    const coalesce = kind === "typing" && this.#lastKind === "typing" && now - this.#lastAt < COALESCE_MS;
    if (!coalesce) this.#undo.push(before);
    this.#redo = [];
    this.#lastKind = kind;
    this.#lastAt = now;
  }

  undo(current: Snapshot): Snapshot | null {
    const previous = this.#undo.pop();
    if (!previous) return null;
    this.#redo.push(current);
    this.#lastKind = null;
    return previous;
  }

  redo(current: Snapshot): Snapshot | null {
    const next = this.#redo.pop();
    if (!next) return null;
    this.#undo.push(current);
    this.#lastKind = null;
    return next;
  }

  clear(): void {
    this.#undo = [];
    this.#redo = [];
    this.#lastKind = null;
  }
}
