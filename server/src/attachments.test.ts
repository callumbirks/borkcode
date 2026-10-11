import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { AttachmentStore, MAX_ATTACHMENT_BYTES } from "./attachments.ts";

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

test("only images within the size limit are accepted, leaving nothing behind when refused", async () => {
  const other = randomUUID();
  await assert.rejects(store.save(other, "page.svg", "image/svg+xml", Readable.from([Buffer.from("<svg/>")])), {
    status: 415,
  });
  await assert.rejects(store.save(other, "notes.txt", "text/plain", Readable.from([Buffer.from("hi")])), { status: 415 });
  await assert.rejects(store.save(other, "empty.png", "image/png", Readable.from([])), { status: 400 });
  const chunk = Buffer.alloc(1024 * 1024);
  const tooBig = Array.from({ length: MAX_ATTACHMENT_BYTES / chunk.length + 1 }, () => chunk);
  await assert.rejects(store.save(other, "huge.png", "image/png", Readable.from(tooBig)), { status: 413 });
  assert.deepEqual(await readdir(store.dir(other)), []);
});

test("removing a thread's attachments deletes its folder", async () => {
  const gone = randomUUID();
  await store.save(gone, "a.webp", "image/webp", Readable.from([Buffer.from("webp")]));
  await store.remove(gone);
  assert.ok(!existsSync(store.dir(gone)));
});
