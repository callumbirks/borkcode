import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Attachment } from "shared/protocol";
import type { TurnAttachment } from "./providers/types.ts";

/** Images go to the model as pixels, so they keep a lower cap than files agents read with tools. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/**
 * New-thread composers keep uploads in memory only, so a reload drops them; a draft folder nothing
 * was added to for a day is from a composer long gone. Checked at start and hourly.
 */
export const STALE_DRAFT_MS = 24 * 60 * 60 * 1000;
export const STALE_DRAFT_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Image types both providers take natively, shown inline in the transcript. Anything else,
 * SVG included, is kept as a plain file and only ever served as a download.
 */
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

export function isNativeImage(mimeType: string): boolean {
  return mimeType in IMAGE_EXTENSIONS;
}

export function maxBytes(mimeType: string): number {
  return isNativeImage(mimeType) ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
}

export function tooLarge(mimeType: string): string {
  return `${isNativeImage(mimeType) ? "Images" : "Files"} can be at most ${maxBytes(mimeType) / 1024 / 1024} MB`;
}

/** The browser's type when it is a well-formed one; it only decides image handling, never serving. */
export function cleanType(mimeType: string): string {
  const type = mimeType.split(";")[0]!.trim().toLowerCase();
  return /^[a-z0-9][\w.+-]*\/[a-z0-9][\w.+-]*$/.test(type) ? type : "application/octet-stream";
}

/**
 * How an attachment is served. Images show inline as themselves; everything else is a download of
 * opaque bytes under its own name, so HTML, SVG or script uploaded as a file never renders from
 * borkcode's origin. The sandbox CSP and `nosniff` hold even if a browser ignored that.
 */
export function servingHeaders(attachment: Attachment): Record<string, string | number> {
  const image = isNativeImage(attachment.mimeType);
  return {
    "content-type": image ? attachment.mimeType : "application/octet-stream",
    "content-length": attachment.size,
    "content-disposition": `${image ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
    // An id always names the same bytes.
    "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  };
}

/** Thread and attachment ids are UUIDs, so a valid id can never step outside its folder. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isId(value: string): boolean {
  return ID.test(value);
}

/** A refused upload, with the HTTP status that says why. */
export class AttachmentError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Files uploaded to threads, kept under `<home>/attachments/<thread id>/` so nothing lands in a
 * repo, beside `<id>.json` with each record. Images are stored as `<id><ext>`; other files as
 * `<id>/<name>`, under their own name so agents' tools recognise them and the prompt reads
 * naturally, in a folder of their own so no name can collide with a record. A thread's folder
 * goes when the thread is deleted.
 *
 * A new thread's composer uploads before the thread exists, to `drafts/<draft id>/`, laid out the
 * same way. Creating the thread moves that folder to the thread's; drafts never sent are removed
 * once stale. `drafts` is not a UUID, so it can never be taken for a thread's folder.
 */
export class AttachmentStore {
  readonly #root: string;

  constructor(home: string) {
    this.#root = join(home, "attachments");
  }

  /** The thread's folder, which its agent may read so it can use the files themselves. */
  dir(threadId: string): string {
    if (!ID.test(threadId)) throw new AttachmentError(404, "Unknown thread");
    return join(this.#root, threadId);
  }

  #draftDir(draftId: string): string {
    if (!ID.test(draftId)) throw new AttachmentError(404, "Unknown draft");
    return join(this.#root, "drafts", draftId);
  }

  /** Streams an upload to disk, refusing bodies over the size limit for its type. */
  async save(threadId: string, name: string, mimeType: string, body: AsyncIterable<Uint8Array>): Promise<Attachment> {
    return this.#save(this.dir(threadId), name, mimeType, body);
  }

  /** Like `save`, for the composer of a thread that doesn't exist yet. */
  async saveDraft(draftId: string, name: string, mimeType: string, body: AsyncIterable<Uint8Array>): Promise<Attachment> {
    return this.#save(this.#draftDir(draftId), name, mimeType, body);
  }

  async #save(dir: string, name: string, mimeType: string, body: AsyncIterable<Uint8Array>): Promise<Attachment> {
    const type = cleanType(mimeType);
    const max = maxBytes(type);
    await mkdir(dir, { recursive: true });
    const id = randomUUID();
    const partial = join(dir, `${id}.part`);
    let size = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > max) callback(new AttachmentError(413, tooLarge(type)));
        else callback(null, chunk);
      },
    });
    try {
      await pipeline(body, limit, createWriteStream(partial));
      if (size === 0) throw new AttachmentError(400, "The file is empty");
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
    const attachment: Attachment = { id, name: cleanName(name, type), mimeType: type, size };
    const path = pathIn(dir, attachment);
    if (!isNativeImage(type)) await mkdir(join(dir, id));
    await rename(partial, path);
    await writeFile(join(dir, `${id}.json`), JSON.stringify(attachment));
    return attachment;
  }

  /** Null for anything that is not an attachment of this thread. */
  get(threadId: string, id: string): TurnAttachment | null {
    return ID.test(threadId) ? getIn(this.dir(threadId), id) : null;
  }

  /** Throws unless every id is an attachment of this thread. */
  resolve(threadId: string, ids: string[]): Attachment[] {
    return resolveIn(this.dir(threadId), ids);
  }

  /** Throws unless every id is an attachment uploaded to this draft. */
  resolveDraft(draftId: string, ids: string[]): Attachment[] {
    return resolveIn(this.#draftDir(draftId), ids);
  }

  /** Makes a draft's uploads the new thread's, before the thread has any of its own. */
  async adoptDraft(draftId: string, threadId: string): Promise<void> {
    const from = this.#draftDir(draftId);
    if (!existsSync(from)) return;
    await mkdir(this.#root, { recursive: true });
    await rename(from, this.dir(threadId));
  }

  /** Removes drafts nothing was uploaded to for `maxAgeMs`, such as a composer closed unsent. */
  async removeStaleDrafts(maxAgeMs: number, now = Date.now()): Promise<void> {
    const root = join(this.#root, "drafts");
    const drafts = await readdir(root).catch(() => []);
    await Promise.all(
      drafts.filter((name) => ID.test(name)).map(async (name) => {
        const dir = join(root, name);
        // Each upload adds files to the folder, which moves its mtime.
        if (now - (await stat(dir)).mtimeMs > maxAgeMs) await rm(dir, { recursive: true, force: true });
      }),
    );
  }

  path(threadId: string, attachment: Attachment): string {
    return pathIn(this.dir(threadId), attachment);
  }

  async remove(threadId: string): Promise<void> {
    if (ID.test(threadId)) await rm(join(this.#root, threadId), { recursive: true, force: true });
  }
}

function pathIn(dir: string, attachment: Attachment): string {
  const image = IMAGE_EXTENSIONS[attachment.mimeType];
  // Records are written by `save`, but the name is checked again before it becomes a path.
  return image
    ? join(dir, `${attachment.id}${image}`)
    : join(dir, attachment.id, cleanName(attachment.name, attachment.mimeType));
}

function getIn(dir: string, id: string): TurnAttachment | null {
  if (!ID.test(id)) return null;
  const record = join(dir, `${id}.json`);
  if (!existsSync(record)) return null;
  const attachment = JSON.parse(readFileSync(record, "utf8")) as Attachment;
  return { ...attachment, path: pathIn(dir, attachment) };
}

function resolveIn(dir: string, ids: string[]): Attachment[] {
  return ids.map((id) => {
    const found = getIn(dir, id);
    if (!found) throw new Error("An attachment is missing; attach the file again");
    const { path: _path, ...attachment } = found;
    return attachment;
  });
}

/** Longest name kept, in UTF-8 bytes, well inside the 255-byte limit of common filesystems. */
const MAX_NAME_BYTES = 200;

/**
 * Shown in the transcript, quoted to the agent and used as the file's name on disk, so it is one
 * plain line, a single path segment, not hidden, and keeps a short alphanumeric extension.
 */
export function cleanName(name: string, mimeType: string): string {
  const base = name
    .normalize("NFC")
    .replace(/^.*[\\/]/, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}"]/gu, "")
    .trim()
    .replace(/^\.+/, "");
  if (!base) return `${isNativeImage(mimeType) ? "image" : "file"}${IMAGE_EXTENSIONS[mimeType] ?? ""}`;
  const dot = extname(base);
  const extension = /^\.[a-z0-9]{1,16}$/i.test(dot) ? dot : "";
  let stem = "";
  for (const char of base.slice(0, base.length - extension.length)) {
    if (Buffer.byteLength(stem + char + extension) > MAX_NAME_BYTES) break;
    stem += char;
  }
  return (stem.trimEnd() || "file") + extension;
}
