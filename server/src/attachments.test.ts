import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { AttachmentStore, cleanName, MAX_FILE_BYTES, MAX_IMAGE_BYTES, servingHeaders } from "./attachments.ts";

const home = await mkdtemp(join(tmpdir(), "borkcode-attachments-"));
after(() => rm(home, { recursive: true, force: true }));
const store = new AttachmentStore(home);
const threadId = randomUUID();

test("an upload is stored under its thread with its record, and found only by its thread and id", async () => {
  const bytes = Buffer.from("not really a png");
  const attachment = await store.save(threadId, 'C:\\shots\\scr"een.png', "image/png", Readable.from([bytes]));
  assert.deepEqual(attachment, { id: attachment.id, name: "screen.png", mimeType: "image/png", size: bytes.length });

  const found = store.get(threadId, attachment.id);
  assert.equal(found?.path, join(home, "attachments", threadId, `${attachment.id}.png`));
  assert.deepEqual(await readFile(found!.path), bytes);
  assert.deepEqual(store.resolve(threadId, [attachment.id]), [attachment]);

  assert.equal(store.get(randomUUID(), attachment.id), null);
  assert.equal(store.get(threadId, randomUUID()), null);
  assert.throws(() => store.resolve(threadId, [randomUUID()]), /attach the file again/);
});

test("ids that are not UUIDs never reach the filesystem", async () => {
  const attachment = await store.save(threadId, "a.gif", "image/gif", Readable.from([Buffer.from("gif")]));
  for (const id of ["..", "../../state.sqlite", `${attachment.id}.json`, `${attachment.id}/..`, ""]) {
    assert.equal(store.get(threadId, id), null);
  }
  assert.equal(store.get("..", attachment.id), null);
  assert.equal(store.get(`${threadId}/..`, attachment.id), null);
  await assert.rejects(store.save("../outside", "a.png", "image/png", Readable.from([Buffer.from("x")])), { status: 404 });
});

const bytes = (size: number) => {
  const chunk = Buffer.alloc(1024 * 1024);
  return Readable.from(Array.from({ length: Math.ceil(size / chunk.length) }, () => chunk));
};

test("any type is accepted and kept under its own name, with the browser's type or a generic one", async () => {
  const pdf = await store.save(threadId, "Report Q3.PDF", "application/pdf", Readable.from([Buffer.from("%PDF")]));
  assert.deepEqual(pdf, { id: pdf.id, name: "Report Q3.PDF", mimeType: "application/pdf", size: 4 });
  assert.equal(store.get(threadId, pdf.id)?.path, join(home, "attachments", threadId, pdf.id, "Report Q3.PDF"));

  for (const [name, type, stored] of [
    ["page.html", "text/html", "text/html"],
    ["logo.svg", "image/svg+xml", "image/svg+xml"],
    ["notes.md", "", "application/octet-stream"],
    ["x.bin", "nonsense", "application/octet-stream"],
    ["data.csv", "Text/CSV; charset=utf-8", "text/csv"],
  ]) {
    const saved = await store.save(threadId, name, type, Readable.from([Buffer.from("x")]));
    assert.equal(saved.mimeType, stored);
    assert.equal(await readFile(store.get(threadId, saved.id)!.path, "utf8"), "x");
  }

  // A file called like a record sits in its own folder, so it cannot replace one.
  const json = await store.save(threadId, "x.json", "application/json", Readable.from([Buffer.from("[1]")]));
  assert.deepEqual(store.resolve(threadId, [json.id]), [json]);
  assert.equal(await readFile(store.get(threadId, json.id)!.path, "utf8"), "[1]");
});

test("names become one safe path segment that keeps a short extension", () => {
  assert.equal(cleanName('C:\\shots\\scr"een.png', "image/png"), "screen.png");
  assert.equal(cleanName("../../etc/passwd", "text/plain"), "passwd");
  assert.equal(cleanName("a/b/../..", "text/plain"), "file");
  assert.equal(cleanName("..", "text/plain"), "file");
  assert.equal(cleanName(".env", "text/plain"), "env");
  assert.equal(cleanName("line\nbreak\u0000.txt", "text/plain"), "linebreak.txt");
  assert.equal(cleanName("", "image/png"), "image.png");
  assert.equal(cleanName("  ", "application/pdf"), "file");
  assert.equal(cleanName("archive.tar.gz", "application/gzip"), "archive.tar.gz");
  assert.equal(cleanName("weird.ext with space", "text/plain"), "weird.ext with space");
  const long = cleanName(`${"é".repeat(300)}.txt`, "text/plain");
  assert.ok(Buffer.byteLength(long) <= 200 && long.endsWith("é.txt"), long);
  assert.equal(cleanName(`${"a".repeat(300)}.${"b".repeat(20)}`, "text/plain").length, 200);
});

test("images are capped lower than other files, and a refusal leaves nothing behind", async () => {
  const other = randomUUID();
  await assert.rejects(store.save(other, "empty.txt", "text/plain", Readable.from([])), { status: 400 });
  await assert.rejects(store.save(other, "huge.png", "image/png", bytes(MAX_IMAGE_BYTES + 1)), {
    status: 413,
    message: "Images can be at most 20 MB",
  });
  await assert.rejects(store.save(other, "huge.zip", "application/zip", bytes(MAX_FILE_BYTES + 1)), {
    status: 413,
    message: "Files can be at most 100 MB",
  });
  assert.deepEqual(await readdir(store.dir(other)), []);
  const big = await store.save(other, "big.zip", "application/zip", bytes(MAX_IMAGE_BYTES + 1));
  assert.ok(big.size > MAX_IMAGE_BYTES);
});

test("images are served inline, and everything else only as a download of opaque bytes", () => {
  const image = servingHeaders({ id: "i", name: "shot.png", mimeType: "image/png", size: 3 });
  assert.equal(image["content-type"], "image/png");
  assert.equal(image["content-disposition"], "inline; filename*=UTF-8''shot.png");
  for (const [name, mimeType] of [
    ["page.html", "text/html"],
    ["logo.svg", "image/svg+xml"],
    ["run.js", "text/javascript"],
    ["notes.txt", "text/plain"],
    ["Q3 report é.pdf", "application/pdf"],
  ]) {
    const headers = servingHeaders({ id: "f", name, mimeType, size: 3 });
    assert.equal(headers["content-type"], "application/octet-stream");
    assert.equal(headers["content-disposition"], `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  for (const headers of [image, servingHeaders({ id: "f", name: "a.html", mimeType: "text/html", size: 1 })]) {
    assert.equal(headers["x-content-type-options"], "nosniff");
    assert.equal(headers["content-security-policy"], "default-src 'none'; sandbox");
  }
});

test("removing a thread's attachments deletes its folder", async () => {
  const gone = randomUUID();
  await store.save(gone, "a.webp", "image/webp", Readable.from([Buffer.from("webp")]));
  await store.remove(gone);
  assert.ok(!existsSync(store.dir(gone)));
});
