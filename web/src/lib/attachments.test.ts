import assert from "node:assert/strict";
import { test } from "node:test";
import { composerAttachments, MAX_ATTACHMENT_BYTES, refusal, type PendingAttachment } from "./attachments.ts";

const pending = (id: string | null, error: string | null = null): PendingAttachment => ({
  key: id ?? "k",
  name: "shot.png",
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

test("files the server would refuse are caught before uploading", () => {
  assert.equal(refusal({ type: "image/png", size: 10 }), null);
  assert.match(refusal({ type: "image/svg+xml", size: 10 }) ?? "", /Only PNG/);
  assert.match(refusal({ type: "", size: 10 }) ?? "", /Only PNG/);
  assert.match(refusal({ type: "image/jpeg", size: MAX_ATTACHMENT_BYTES + 1 }) ?? "", /at most 20 MB/);
});
