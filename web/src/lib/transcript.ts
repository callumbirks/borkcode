import type { Item, TranscriptItem, TurnWindow } from "shared/protocol";

/**
 * Applies an `item.upserted` to the turns the client holds. An item it doesn't hold is new, and
 * goes at the end, unless its seq is before the window: then it is in an older turn that isn't
 * loaded, and loading that turn will bring it. A moved item (`toEnd`) always goes to the end.
 */
export function upsertItem(window: TurnWindow, item: Item, seq: number | undefined, toEnd = false): void {
  const index = window.items.findIndex((entry) => entry.id === item.id);
  if (toEnd) {
    if (index !== -1) window.items.splice(index, 1);
    window.items.push(item);
  } else if (index !== -1) window.items[index] = item;
  else if (seq === undefined || seq >= window.from) window.items.push(item);
}

/** Puts older turns before the ones held, skipping any item already held, such as one moved to the end. */
export function prependOlder(window: TurnWindow, older: TurnWindow): void {
  const held = new Set(window.items.map((item) => item.id));
  window.items.unshift(...older.items.filter((item: TranscriptItem) => !held.has(item.id)));
  window.from = older.from;
}
