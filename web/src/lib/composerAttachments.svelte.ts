import { uploadKey } from "./browser";
import { isImage, refusal, upload, type PendingAttachment } from "./attachments";

/**
 * Files waiting in each composer, keyed like drafts, kept in memory so switching threads keeps
 * them. Each upload starts as soon as the file is added; a reload drops them, like an unsent
 * upload form.
 */
const byComposer = $state<Record<string, PendingAttachment[]>>({});

export function pendingAttachments(key: string): PendingAttachment[] {
  return byComposer[key] ?? [];
}

export function attachFiles(key: string, url: string, files: File[]): void {
  byComposer[key] ??= [];
  const list = byComposer[key];
  for (const file of files) {
    list.push({
      key: uploadKey(),
      name: file.name,
      mimeType: file.type,
      size: file.size,
      preview: isImage(file.type) ? URL.createObjectURL(file) : null,
      progress: 0,
      attachment: null,
      error: refusal(file),
    });
    // The reactive copy, so progress and results repaint the thumbnail or chip.
    const entry = list.at(-1)!;
    if (entry.error) continue;
    upload(url, file, (fraction) => (entry.progress = fraction)).then(
      (attachment) => (entry.attachment = attachment),
      (error: Error) => (entry.error = error.message),
    );
  }
}

export function removeAttachment(key: string, entryKey: string): void {
  const list = byComposer[key] ?? [];
  const index = list.findIndex((each) => each.key === entryKey);
  if (index < 0) return;
  revoke(list[index]!);
  list.splice(index, 1);
}

/** Empties the composer for sending; `restoreAttachments` puts them back if the send fails. */
export function takeAttachments(key: string): PendingAttachment[] {
  const list = byComposer[key] ?? [];
  delete byComposer[key];
  return list;
}

export function restoreAttachments(key: string, list: PendingAttachment[]): void {
  byComposer[key] = [...list, ...(byComposer[key] ?? [])];
}

/** Once sent, the transcript shows the server's copies. */
export function releaseAttachments(list: PendingAttachment[]): void {
  for (const each of list) revoke(each);
}

function revoke(each: PendingAttachment): void {
  if (each.preview) URL.revokeObjectURL(each.preview);
}
