import { refusal, upload, type PendingAttachment } from "./attachments";

/**
 * Files waiting in each thread's composer, kept in memory so switching threads keeps them. Each
 * upload starts as soon as the file is added; a reload drops them, like an unsent upload form.
 */
const byThread = $state<Record<string, PendingAttachment[]>>({});

export function pendingAttachments(threadId: string): PendingAttachment[] {
  return byThread[threadId] ?? [];
}

export function attachFiles(threadId: string, files: File[]): void {
  byThread[threadId] ??= [];
  const list = byThread[threadId];
  for (const file of files) {
    list.push({
      key: crypto.randomUUID(),
      name: file.name,
      preview: URL.createObjectURL(file),
      progress: 0,
      attachment: null,
      error: refusal(file),
    });
    // The reactive copy, so progress and results repaint the thumbnail.
    const entry = list.at(-1)!;
    if (entry.error) continue;
    upload(threadId, file, (fraction) => (entry.progress = fraction)).then(
      (attachment) => (entry.attachment = attachment),
      (error: Error) => (entry.error = error.message),
    );
  }
}

export function removeAttachment(threadId: string, key: string): void {
  const list = byThread[threadId] ?? [];
  const index = list.findIndex((each) => each.key === key);
  if (index < 0) return;
  URL.revokeObjectURL(list[index]!.preview);
  list.splice(index, 1);
}

/** Empties the composer for sending; `restoreAttachments` puts them back if the send fails. */
export function takeAttachments(threadId: string): PendingAttachment[] {
  const list = byThread[threadId] ?? [];
  delete byThread[threadId];
  return list;
}

export function restoreAttachments(threadId: string, list: PendingAttachment[]): void {
  byThread[threadId] = [...list, ...(byThread[threadId] ?? [])];
}

/** Once sent, the transcript shows the server's copies. */
export function releaseAttachments(list: PendingAttachment[]): void {
  for (const each of list) URL.revokeObjectURL(each.preview);
}
