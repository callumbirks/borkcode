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
    (await search.search("t1", "server")).filter(m => m.kind === "file").map((mention) => [mention.repo, mention.path, mention.reference]),
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

test("thread title matching excludes current, archived and other-project threads", async () => {
  const { threadMentions } = await import("./mentions.ts");
  const base = { project: "demo", title: "Server design", status: "idle", archivedAt: null, updatedAt: 1 };
  const list = [
    { ...base, id: "current" }, { ...base, id: "match" },
    { ...base, id: "archived", archivedAt: 1 }, { ...base, id: "other", project: "other" },
    { ...base, id: "nomatch", title: "Frontend" },
  ] as import("shared/protocol").Thread[];
  assert.deepEqual(threadMentions(list, "demo", "current", "serv").map(t => t.threadId), ["match"]);
  assert.equal(threadMentions(list, "demo", "current", "serv")[0].reference, "borkcode:thread:match");
  const project = await new ProjectStore(join(scratch, "picker-home")).create("demo");
  const files = new FileStore(new ProjectStore(join(scratch, "picker-home")), () => {});
  for (let i = 0; i < 55; i++) await files.write("demo", `s${i}.md`, "", null);
  const search = new MentionSearch(files, async () => ({ project, root: project.path }), () => list);
  const matches = await search.search("current", "");
  assert.equal(matches.length, 50);
  assert.ok(matches.every(m => m.kind === "file"));
  assert.equal((await search.search("current", "serv"))[0].kind, "thread");
  assert.ok(matches.some(m => m.kind === "file"));
});


test("thread mode searches all projects, ranks local then recent, and omits files", async () => {
  const projects = new ProjectStore(join(scratch, "thread-mode-home"));
  const project = await projects.create("demo");
  await projects.create("other");
  const files = new FileStore(projects, () => {});
  await files.write("demo", "notes.md", "", null);
  const { Database, toThread } = await import("./db.ts");
  const db = new Database(join(scratch, "thread-mode.sqlite"));
  const seed = (id: string, project: string, updatedAt: number, archivedAt: number | null = null) => {
    db.insertThread({ id, project, title: `Notes ${id}`, provider: "codex", model: null, effort: null,
      accessMode: "full", workspace: null, branch: null, status: "idle", parentId: null, captain: false,
      watched: false, queued: 0, paused: false, archivedAt, respondedAt: null, readAt: null, markedUnread: false,
      createdAt: 1, updatedAt, providerSessionId: null, startBranch: null });
  };
  seed("current", "demo", 500);
  seed("local-old", "demo", 10);
  seed("local-new", "demo", 20);
  seed("other-old", "other", 100);
  seed("other-new", "other", 200);
  seed("archived", "other", 300, 1);
  const search = new MentionSearch(files, async () => ({ project, root: project.path }), () => db.listThreads().map(t => toThread(t, false)));
  const all = await search.search("current", "notes", "threads");
  assert.deepEqual(all.map(t => t.kind === "thread" && [t.threadId, t.project, t.status]), [
    ["local-new", "demo", "idle"], ["local-old", "demo", "idle"],
    ["other-new", "other", "idle"], ["other-old", "other", "idle"],
  ]);
  assert.deepEqual(await search.search("current", "missing", "threads"), []);
  const mixed = await search.search("current", "notes");
  assert.deepEqual(mixed.filter(t => t.kind === "thread").map(t => t.threadId).sort(), ["local-new", "local-old"]);
  assert.ok(mixed.some(t => t.kind === "file"));
  assert.ok((await search.search("current", "")).every(t => t.kind === "file"));
  for (let i = 0; i < 55; i++) seed(`extra-${i}`, "other", i);
  assert.equal((await search.search("current", "", "threads")).length, 50);
});


test("thread queries rank project first, then title relevance and recency; empty queries use recency", async () => {
  const { threadMentions } = await import("./mentions.ts");
  const base = { project: "demo", status: "idle", archivedAt: null };
  const threads = [
    { ...base, id: "local-weak", title: "n_o_t_e_s", updatedAt: 200 },
    { ...base, id: "local-prefix", title: "Notes plan", updatedAt: 100 },
    { ...base, id: "local-exact-old", title: "Notes", updatedAt: 1 },
    { ...base, id: "local-exact-new", title: "Notes", updatedAt: 5 },
    { ...base, id: "other-weak", project: "other", title: "n_o_t_e_s", updatedAt: 2000 },
    { ...base, id: "other-exact", project: "other", title: "Notes", updatedAt: 1000 },
  ] as import("shared/protocol").Thread[];
  assert.deepEqual(threadMentions(threads, "demo", "current", "notes", "threads").map(t => t.threadId), [
    "local-exact-new", "local-exact-old", "local-prefix", "local-weak", "other-exact", "other-weak",
  ]);
  assert.deepEqual(threadMentions(threads, "demo", "current", "", "threads").map(t => t.threadId), [
    "local-weak", "local-prefix", "local-exact-new", "local-exact-old", "other-weak", "other-exact",
  ]);
});
