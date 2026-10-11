import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Attachment } from "shared/protocol";
import type { TurnAttachment } from "./providers/types.ts";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Image types both providers take natively, and the only uploads accepted for now. SVG is left
 * out on purpose: served from borkcode's origin it could run script.
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

/** Thread and attachment ids are UUIDs, so a valid id can never step outside its folder. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
 * repo: the bytes as `<id><ext>` (the extension tells agents' tools what the file is) beside
 * `<id>.json` with its record. A thread's folder goes when the thread is deleted.
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

  /** Streams an upload to disk, refusing types not accepted and bodies over the size limit. */
  async save(threadId: string, name: string, mimeType: string, body: AsyncIterable<Uint8Array>): Promise<Attachment> {
    const extension = IMAGE_EXTENSIONS[mimeType];
    if (!extension) throw new AttachmentError(415, "Only PNG, JPEG, GIF and WebP images can be attached");
    const dir = this.dir(threadId);
    await mkdir(dir, { recursive: true });
    const id = randomUUID();
    const partial = join(dir, `${id}.part`);
    let size = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > MAX_ATTACHMENT_BYTES) {
          callback(new AttachmentError(413, `Attachments can be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`));
        } else {
          callback(null, chunk);
        }
      },
    });
    try {
      await pipeline(body, limit, createWriteStream(partial));
      if (size === 0) throw new AttachmentError(400, "The file is empty");
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
    const attachment: Attachment = { id, name: cleanName(name, extension), mimeType, size };
    await rename(partial, join(dir, `${id}${extension}`));
    await writeFile(join(dir, `${id}.json`), JSON.stringify(attachment));
    return attachment;
  }

  /** Null for anything that is not an attachment of this thread. */
  get(threadId: string, id: string): TurnAttachment | null {
    if (!ID.test(threadId) || !ID.test(id)) return null;
    const record = join(this.#root, threadId, `${id}.json`);
    if (!existsSync(record)) return null;
    const attachment = JSON.parse(readFileSync(record, "utf8")) as Attachment;
    return { ...attachment, path: this.path(threadId, attachment) };
  }

  /** Throws unless every id is an attachment of this thread. */
  resolve(threadId: string, ids: string[]): Attachment[] {
    return ids.map((id) => {
      const found = this.get(threadId, id);
      if (!found) throw new Error("An attachment is missing; attach the file again");
      const { path: _path, ...attachment } = found;
      return attachment;
    });
  }

  path(threadId: string, attachment: Attachment): string {
    return join(this.dir(threadId), `${attachment.id}${IMAGE_EXTENSIONS[attachment.mimeType] ?? ""}`);
  }

  async remove(threadId: string): Promise<void> {
    if (ID.test(threadId)) await rm(join(this.#root, threadId), { recursive: true, force: true });
  }
}

/** Shown in the transcript and quoted to the agent, so keep it one plain line. */
function cleanName(name: string, extension: string): string {
  const base = name.replace(/[\u0000-\u001f\u007f"]/g, "").replace(/^.*[\\/]/, "").trim().slice(0, 200);
  return base || `image${extension}`;
}
