import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeContent } from "./claude.ts";
import { codexInput } from "./codex.ts";

const image = { id: "i1", name: "shot.png", mimeType: "image/png", size: 3, path: "/home/a/attachments/t/i1.png" };
const note = '[Attached image "shot.png" is saved at: /home/a/attachments/t/i1.png]';
const notes = { id: "f1", name: "notes.txt", mimeType: "text/plain", size: 2048, path: "/home/a/attachments/t/f1/notes.txt" };
const fileNote = '[Attached file "notes.txt" (text/plain, 2 KB) is saved at: /home/a/attachments/t/f1/notes.txt]';

test("Claude gets images as base64 blocks before the text, which names their paths", () => {
  assert.equal(claudeContent("hello", []), "hello");
  assert.deepEqual(claudeContent("what is this?", [{ ...image, base64: "AAAA" }]), [
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    { type: "text", text: `what is this?\n\n${note}` },
  ]);
  // A file that is not an image reaches Claude by its path only.
  assert.deepEqual(claudeContent("", [{ ...notes, base64: null }]), [{ type: "text", text: fileNote }]);
});

test("Codex gets images by local path after the text, which names their paths", () => {
  assert.deepEqual(codexInput("hello", []), [{ type: "text", text: "hello", text_elements: [] }]);
  assert.deepEqual(codexInput("", [image, notes]), [
    { type: "text", text: `${note}\n\n${fileNote}`, text_elements: [] },
    { type: "localImage", path: image.path },
  ]);
});

test("files that are not images are named with their type and size, and SVG is not an image", () => {
  const svg = { id: "s1", name: "logo.svg", mimeType: "image/svg+xml", size: 3 * 1024 * 1024 / 2, path: "/a/s1/logo.svg" };
  assert.deepEqual(codexInput("look", [svg]), [
    { type: "text", text: 'look\n\n[Attached file "logo.svg" (image/svg+xml, 1.5 MB) is saved at: /a/s1/logo.svg]', text_elements: [] },
  ]);
});
