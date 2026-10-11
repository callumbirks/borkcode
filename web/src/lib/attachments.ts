import type { Attachment } from "shared/protocol";

/** Matches the server's limit, so an oversized file fails before it uploads. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** What the server accepts for now; it is the authority and says why it refuses. */
export const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export function attachmentUrl(threadId: string, attachmentId: string): string {
  return `/api/threads/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

/** A file in the composer: uploading, uploaded, or refused. */
export interface PendingAttachment {
  key: string;
  name: string;
  /** A local object URL, so the thumbnail shows before the upload finishes. */
  preview: string;
  /** From 0 to 1 while uploading. */
  progress: number;
  attachment: Attachment | null;
  error: string | null;
}

/** Why a file cannot be attached, before uploading it, or null if it can. */
export function refusal(file: { type: string; size: number }): string | null {
  if (!ACCEPTED_TYPES.includes(file.type)) return "Only PNG, JPEG, GIF and WebP images can be attached";
  if (file.size > MAX_ATTACHMENT_BYTES) return `Images can be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`;
  return null;
}

/** Sending waits for every upload, and for refused files to be removed so none is silently dropped. */
export function composerAttachments(pending: PendingAttachment[]): { ids: string[]; ready: boolean } {
  return {
    ids: pending.flatMap((each) => (each.attachment ? [each.attachment.id] : [])),
    ready: pending.every((each) => each.attachment !== null),
  };
}

/** Uploads with XMLHttpRequest, since fetch cannot report upload progress. */
export function upload(threadId: string, file: File, onProgress: (fraction: number) => void): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/api/threads/${encodeURIComponent(threadId)}/attachments`);
    request.setRequestHeader("content-type", file.type);
    request.setRequestHeader("x-filename", encodeURIComponent(file.name));
    request.responseType = "json";
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      const body = request.response as (Attachment & { error?: string }) | null;
      if (request.status === 200 && body) resolve(body);
      else reject(new Error(body?.error ?? `Upload failed (${request.status})`));
    };
    request.onerror = () => reject(new Error("Upload failed; is borkcode still running?"));
    request.send(file);
  });
}
