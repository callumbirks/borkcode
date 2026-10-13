import type { TranscriptItem } from "shared/protocol";

/** A transcript row: a message or notice on its own, or a run of tool calls and reasoning. */
export type Segment = { kind: "item"; item: TranscriptItem } | { kind: "work"; id: string; items: TranscriptItem[] };

const segmentKey = (segment: Segment) => (segment.kind === "item" ? segment.item.id : segment.id);

/**
 * Folds consecutive tool calls and reasoning into work segments. A segment whose items are the
 * same objects as in `previous` is returned as the same object, so one changed item re-renders
 * its own row rather than every row in a long thread.
 */
export function segmentItems(items: TranscriptItem[], previous: Segment[] = []): Segment[] {
  const fresh: Segment[] = [];
  for (const item of items) {
    const last = fresh.at(-1);
    if (item.kind !== "tool" && item.kind !== "reasoning") fresh.push({ kind: "item", item });
    else if (last?.kind === "work") last.items.push(item);
    else fresh.push({ kind: "work", id: item.id, items: [item] });
  }
  const before = new Map(previous.map((segment) => [segmentKey(segment), segment]));
  return fresh.map((segment) => {
    const old = before.get(segmentKey(segment));
    if (segment.kind === "item") return old?.kind === "item" && old.item === segment.item ? old : segment;
    const same =
      old?.kind === "work" &&
      old.items.length === segment.items.length &&
      old.items.every((item, index) => item === segment.items[index]);
    return same ? old : segment;
  });
}
