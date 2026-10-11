import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { git } from "./exec.ts";
import { FileStore } from "./files.ts";
import { fileReference, matchScore, MentionSearch } from "./mentions.ts";
import { ProjectStore } from "./projects.ts";
import { ensureWorkspace, workspacePath } from "./workspaces.ts";

const scratch = await mkdtemp(join(tmpdir(), "borkcode-mentions-"));
after(() => rm(scratch, { recursive: true, force: true }));

function rank(query: string, paths: string[]): string[] {
  return paths
    .filter((path) => matchScore(query, path) !== null)
    .sort((a, b) => matchScore(query, a)! - matchScore(query, b)!);
}

test("file name matches outrank folder matches, and shorter paths win ties", () => {
  const paths = [
    "web/src/components/ThreadView.svelte",
    "server/src/threads.ts",
    "server/src/threads.test.ts",
    "docs/threads/notes.md",
    "server/src/main.ts",
  ];
  assert.deepEqual(rank("threads", paths), [
    "server/src/threads.ts",
    "server/src/threads.test.ts",
    "docs/threads/notes.md",
    "web/src/components/ThreadView.svelte",
  ]);
  assert.deepEqual(rank("thrview", paths), ["web/src/components/ThreadView.svelte"]);
  assert.deepEqual(rank("srcmain", paths), ["server/src/main.ts"]);
  assert.deepEqual(rank("", paths)[0], "server/src/main.ts");
  assert.equal(matchScore("zzz", "server/src/main.ts"), null);
});

test("references quote paths with spaces", () => {
  assert.equal(fileReference("app/src/main.ts"), "@app/src/main.ts");
  assert.equal(fileReference("/p/files/my notes.md"), '@"/p/files/my notes.md"');
});

test("search lists repo files, skipping ignored ones, and project files by absolute path", async () => {
  const origin = join(scratch, "origin");
  await git(scratch, "init", "-q", "-b", "main", origin);
  await git(origin, "config", "user.email", "test@example.com");
  await git(origin, "config", "user.name", "test");
  await mkdir(join(origin, "src"));
  await writeFile(join(origin, "src", "server.ts"), "");
  await writeFile(join(origin, ".gitignore"), "dist/\n");
  await git(origin, "add", ".");
  await git(origin, "commit", "-q", "-m", "init");

  const projects = new ProjectStore(join(scratch, "home"));
  await projects.create("demo");
  await projects.addRepo("demo", origin, "app");
  const project = await projects.get("demo");
  await ensureWorkspace(project, "t1", "borkcode/t1");
  const root = workspacePath(project, "t1");
  await writeFile(join(root, "app", "src", "draft.ts"), "");
  await mkdir(join(root, "app", "dist"));
  await writeFile(join(root, "app", "dist", "server.js"), "");

  const files = new FileStore(projects, () => {});
  await files.write("demo", "specs/server.md", "# Server\n", null);
  const search = new MentionSearch(files, async () => ({ project, root }));

  assert.deepEqual(
    (await search.search("t1", "server")).map((mention) => [mention.repo, mention.path, mention.reference]),
    [
      [null, "specs/server.md", `@${join(project.path, "files", "specs", "server.md")}`],
      ["app", "src/server.ts", "@app/src/server.ts"],
    ],
  );
  assert.deepEqual(
    (await search.search("t1", "draft")).map((mention) => mention.reference),
    ["@app/src/draft.ts"],
  );
});
