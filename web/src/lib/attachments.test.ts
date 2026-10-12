import assert from "node:assert/strict";
import { test } from "node:test";
import { composerAttachments, fileKind, formatSize, MAX_FILE_BYTES, MAX_IMAGE_BYTES, refusal, type PendingAttachment } from "./attachments.ts";

const pending = (id: string | null, error: string | null = null): PendingAttachment => ({
  key: id ?? "k",
  name: "shot.png",
  mimeType: "image/png",
  size: 1,
  preview: "blob:x",
  progress: id ? 1 : 0.5,
  attachment: id ? { id, name: "shot.png", mimeType: "image/png", size: 1 } : null,
  error,
});

test("a message can go once every attachment has uploaded, and not while one uploads or failed", () => {
  assert.deepEqual(composerAttachments([]), { ids: [], ready: true });
  assert.deepEqual(composerAttachments([pending("a"), pending("b")]), { ids: ["a", "b"], ready: true });
  assert.deepEqual(composerAttachments([pending("a"), pending(null)]), { ids: ["a"], ready: false });
  assert.deepEqual(composerAttachments([pending(null, "Too big")]), { ids: [], ready: false });
});

test("files the server would refuse are caught before uploading: images by the image cap, others by the file cap", () => {
  assert.equal(refusal({ type: "image/png", size: 10 }), null);
  assert.equal(refusal({ type: "image/svg+xml", size: 10 }), null);
  assert.equal(refusal({ type: "", size: 10 }), null);
  assert.equal(refusal({ type: "application/pdf", size: MAX_IMAGE_BYTES + 1 }), null);
  assert.equal(refusal({ type: "text/plain", size: 0 }), "The file is empty");
  assert.equal(refusal({ type: "image/jpeg", size: MAX_IMAGE_BYTES + 1 }), "Images can be at most 20 MB");
  assert.equal(refusal({ type: "", size: MAX_FILE_BYTES + 1 }), "Files can be at most 100 MB");
});

test("file chips show a size and an icon by broad kind", () => {
  assert.deepEqual([formatSize(5), formatSize(2048), formatSize(3 * 1024 * 1024 / 2)], ["5 B", "2 KB", "1.5 MB"]);
  assert.equal(fileKind("a.pdf", "application/pdf"), "text");
  assert.equal(fileKind("logo.SVG", "image/svg+xml"), "image");
  assert.equal(fileKind("a.tar.gz", "application/gzip"), "archive");
  assert.equal(fileKind("main.rs", "application/octet-stream"), "code");
  assert.equal(fileKind("README", "text/plain"), "text");
  assert.equal(fileKind("clip.mov", "video/quicktime"), "video");
  assert.equal(fileKind("blob", ""), "other");
});
