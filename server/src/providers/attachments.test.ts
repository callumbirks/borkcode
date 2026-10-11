import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeContent } from "./claude.ts";
import { codexInput } from "./codex.ts";

const image = { id: "i1", name: "shot.png", mimeType: "image/png", size: 3, path: "/home/a/attachments/t/i1.png" };
const note = '[Attached file "shot.png" is saved at: /home/a/attachments/t/i1.png]';

test("Claude gets images as base64 blocks before the text, which names their paths", () => {
  assert.equal(claudeContent("hello", []), "hello");
  assert.deepEqual(claudeContent("what is this?", [{ ...image, base64: "AAAA" }]), [
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    { type: "text", text: `what is this?\n\n${note}` },
  ]);
  // A file that is not an image reaches Claude by its path only.
  assert.deepEqual(claudeContent("", [{ ...image, mimeType: "text/plain", base64: null }]), [
    { type: "text", text: note },
  ]);
});

test("Codex gets images by local path after the text, which names their paths", () => {
  assert.deepEqual(codexInput("hello", []), [{ type: "text", text: "hello", text_elements: [] }]);
  assert.deepEqual(codexInput("", [image, { ...image, mimeType: "text/plain" }]), [
    { type: "text", text: `${note}\n\n${note}`, text_elements: [] },
    { type: "localImage", path: image.path },
  ]);
});
