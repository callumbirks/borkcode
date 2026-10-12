import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { locate, locateAll, MAX_TEXT_BYTES, readPreview, type PreviewRoots } from "./threadFiles.ts";

const scratch = await mkdtemp(join(tmpdir(), "borkcode-thread-files-"));
after(() => rm(scratch, { recursive: true, force: true }));

const roots: PreviewRoots = {
  workspace: join(scratch, "worktrees", "thread"),
  project: join(scratch, "files"),
  repos: ["app", "lib"],
};
const outside = join(scratch, "secret.txt");

async function put(path: string, content: string | Buffer = "x") {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

await put(join(roots.workspace, "app", "src", "main.ts"), "console.log(1);\n");
await put(join(roots.workspace, "app", ".git"), "gitdir: elsewhere");
await put(join(roots.workspace, "lib", "README.md"), "# lib\n");
await put(join(roots.workspace, ".scratch", "brief.md"), "brief");
await put(join(roots.project, "plan.md"), "plan");
await put(outside, "secret");
await symlink(outside, join(roots.workspace, "app", "leak.txt"));
await symlink(scratch, join(roots.workspace, "lib", "up"));
await symlink(join(roots.workspace, "app", "src"), join(roots.workspace, "lib", "src-link"));

test("paths are found from the workspace root, any repo, the project files or absolute", async () => {
  assert.deepEqual(await locate(roots, "app/src/main.ts"), { root: "workspace", path: "app/src/main.ts", kind: "file" });
  assert.deepEqual(await locate(roots, "src/main.ts"), { root: "workspace", path: "app/src/main.ts", kind: "file" });
  assert.deepEqual(await locate(roots, "README.md"), { root: "workspace", path: "lib/README.md", kind: "file" });
  assert.deepEqual(await locate(roots, ".scratch/brief.md"), { root: "workspace", path: ".scratch/brief.md", kind: "file" });
  assert.deepEqual(await locate(roots, "plan.md"), { root: "project", path: "plan.md", kind: "file" });
  assert.deepEqual(await locate(roots, "app/src/"), { root: "workspace", path: "app/src", kind: "directory" });
  assert.deepEqual(await locate(roots, join(roots.workspace, "app/src/main.ts")), {
    root: "workspace",
    path: "app/src/main.ts",
    kind: "file",
  });
  assert.deepEqual(await locate(roots, join(roots.project, "plan.md")), { root: "project", path: "plan.md", kind: "file" });
  // A symlink that stays inside the workspace is fine.
  assert.deepEqual(await locate(roots, "lib/src-link/main.ts"), {
    root: "workspace",
    path: "lib/src-link/main.ts",
    kind: "file",
  });
});

test("nothing outside the roots is found, however it is written", async () => {
  const refused = [
    "main",
    "nope/main.ts",
    "",
    ".",
    outside,
    "../../secret.txt",
    "app/../../../secret.txt",
    "app/leak.txt",
    "lib/up/secret.txt",
    "app/.git",
    join(scratch, "worktrees", "thread-other", "app", "x"),
    "/etc/passwd",
  ];
  assert.deepEqual(await locateAll(roots, refused), refused.map(() => null));
  await assert.rejects(locateAll(roots, Array.from({ length: 201 }, () => "x")), /At most 200/);
});

test("previews refuse escapes and git folders", async () => {
  for (const path of ["../secret.txt", "../../secret.txt", outside, "app/leak.txt", "lib/up/secret.txt", "app/.git"]) {
    await assert.rejects(readPreview(roots, "workspace", path), { status: 404 }, path);
  }
  await assert.rejects(readPreview(roots, "project", "../worktrees/thread/app/src/main.ts"), { status: 404 });
});

test("previews serve text, images, folders and refuse binaries", async () => {
  assert.deepEqual(await readPreview(roots, "workspace", "app/src/main.ts"), {
    kind: "text",
    text: Buffer.from("console.log(1);\n"),
    size: 16,
    truncated: false,
  });

  await put(join(roots.workspace, "app", "big.log"), Buffer.alloc(MAX_TEXT_BYTES + 10, "a"));
  const big = await readPreview(roots, "workspace", "app/big.log");
  assert.ok(big.kind === "text" && big.truncated && big.size === MAX_TEXT_BYTES + 10);
  assert.equal(big.kind === "text" && big.text.length, MAX_TEXT_BYTES);

  // Script-bearing types are text, never active content.
  await put(join(roots.workspace, "app", "logo.svg"), "<svg><script>alert(1)</script></svg>");
  await put(join(roots.workspace, "app", "page.html"), "<script>alert(1)</script>");
  assert.equal((await readPreview(roots, "workspace", "app/logo.svg")).kind, "text");
  assert.equal((await readPreview(roots, "workspace", "app/page.html")).kind, "text");

  await put(join(roots.workspace, "app", "shot.PNG"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]));
  const image = await readPreview(roots, "workspace", "app/shot.PNG");
  assert.ok(image.kind === "image" && image.mimeType === "image/png" && image.size === 6);

  await put(join(roots.workspace, "app", "blob.bin"), Buffer.from([1, 2, 0, 3]));
  await assert.rejects(readPreview(roots, "workspace", "app/blob.bin"), { status: 415 });

  const listing = await readPreview(roots, "workspace", "app");
  assert.deepEqual(listing.kind === "directory" && listing.entries.map((entry) => entry.name), [
    "src",
    "big.log",
    "blob.bin",
    "logo.svg",
    "page.html",
    "shot.PNG",
  ]);
});
