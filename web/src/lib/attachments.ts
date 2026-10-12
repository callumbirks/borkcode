import type { Attachment } from "shared/protocol";

/** Match the server's limits, so an oversized file fails before it uploads. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Images the agents see as pixels and the transcript shows inline; any other file is a download. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export function isImage(mimeType: string): boolean {
  return IMAGE_TYPES.includes(mimeType);
}

export function attachmentUrl(threadId: string, attachmentId: string): string {
  return `/api/threads/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

/** A file in the composer: uploading, uploaded, or refused. */
export interface PendingAttachment {
  key: string;
  name: string;
  mimeType: string;
  size: number;
  /** A local object URL for images, so the thumbnail shows before the upload finishes. */
  preview: string | null;
  /** From 0 to 1 while uploading. */
  progress: number;
  attachment: Attachment | null;
  error: string | null;
}

/** Why a file cannot be attached, before uploading it, or null if it can. */
export function refusal(file: { type: string; size: number }): string | null {
  if (file.size === 0) return "The file is empty";
  const image = isImage(file.type);
  const max = image ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  if (file.size > max) return `${image ? "Images" : "Files"} can be at most ${max / 1024 / 1024} MB`;
  return null;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export type FileKind = "image" | "text" | "code" | "data" | "archive" | "audio" | "video" | "other";

const KIND_BY_EXTENSION: Record<string, FileKind> = {
  txt: "text", md: "text", pdf: "text", doc: "text", docx: "text", rtf: "text", log: "text",
  csv: "data", tsv: "data", xls: "data", xlsx: "data", json: "data", sqlite: "data", parquet: "data",
  zip: "archive", gz: "archive", tgz: "archive", tar: "archive", xz: "archive", bz2: "archive", "7z": "archive", rar: "archive",
  ts: "code", js: "code", svelte: "code", py: "code", rs: "code", go: "code", html: "code", css: "code", sh: "code",
  yaml: "code", yml: "code", toml: "code", xml: "code", c: "code", h: "code", cpp: "code", java: "code", swift: "code",
};

/** The broad kind a file chip's icon shows, from the type where it says enough, else the extension. */
export function fileKind(name: string, mimeType: string): FileKind {
  const [major] = mimeType.split("/");
  if (major === "image" || major === "audio" || major === "video") return major;
  return KIND_BY_EXTENSION[name.split(".").at(-1)!.toLowerCase()] ?? (major === "text" ? "text" : "other");
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
    request.setRequestHeader("content-type", file.type || "application/octet-stream");
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
