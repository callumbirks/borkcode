import type { Thread } from "shared/protocol";
import { findFileReferences, type FileReference, type ReferenceRoots } from "./fileReferences.ts";

export function threadReference(id: string): string {
  return `borkcode:thread:${id}`;
}

export interface ThreadReference extends FileReference {
  threadId: string;
}

/** IDs are UUIDs; punctuation around a reference stays ordinary text. */
export function findThreadReferences(text: string, threads: Pick<Thread, "id" | "title" | "project" | "status" | "archivedAt">[]): ThreadReference[] {
  const found: ThreadReference[] = [];
  for (const match of text.matchAll(/(?<=^|[\s(])borkcode:thread:([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})(?![\w-])/gi)) {
    const id = match[1].toLowerCase();
    const thread = threads.find(t => t.id === id);
    found.push({ start: match.index, end: match.index + match[0].length, threadId: id,
      name: thread?.title ?? "Deleted thread", label: thread ? `${thread.project} · ${thread.status}${thread.archivedAt !== null ? " · archived" : ""}` : `Unknown thread · ${id}` });
  }
  return found;
}

export function findReferences(text: string, roots: ReferenceRoots | null, threads: Parameters<typeof findThreadReferences>[1]): (FileReference | ThreadReference)[] {
  return [...(roots ? findFileReferences(text, roots) : []), ...findThreadReferences(text, threads)].sort((a, b) => a.start - b.start);
}

export function isThreadReference(reference: FileReference): reference is ThreadReference {
  return "threadId" in reference;
}
