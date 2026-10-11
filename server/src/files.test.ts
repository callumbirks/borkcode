import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ProjectFile } from "shared/protocol";
import { FileStore } from "./files.ts";
import { ProjectStore } from "./projects.ts";

const home = await mkdtemp(join(tmpdir(), "borkcode-files-"));
const projects = new ProjectStore(home);
await projects.create("demo");
let onChange: (project: string, files: ProjectFile[]) => void = () => {};
const files = new FileStore(projects, (project, list) => onChange(project, list));
after(() => rm(home, { recursive: true, force: true }));

test("files are written into folders, listed and read back", async () => {
  await files.write("demo", "specs/login.md", "# Login\n", null);
  await files.write("demo", "notes.txt", "remember\n");
  assert.deepEqual(
    (await files.list("demo")).map((file) => [file.path, file.size]),
    [
      ["notes.txt", 9],
      ["specs/login.md", 8],
    ],
  );
  assert.equal((await files.read("demo", "specs/login.md")).content, "# Login\n");
  await files.delete("demo", "notes.txt");
  await assert.rejects(files.read("demo", "notes.txt"), /no project file notes.txt/);
});

test("a save refuses to overwrite a change made since the file was opened", async () => {
  const opened = await files.write("demo", "plan.md", "v1\n", null);
  await assert.rejects(files.write("demo", "plan.md", "again\n", null), /already exists/);
  // Someone else, say an agent with its own tools, edits the file.
  await writeFile(join(files.root("demo"), "plan.md"), "agent edit\n");
  await assert.rejects(files.write("demo", "plan.md", "mine\n", opened.modifiedAt), /changed since it was opened/);
  const current = await files.read("demo", "plan.md");
  assert.equal(current.content, "agent edit\n");
  await files.write("demo", "plan.md", "mine\n", current.modifiedAt);
});

test("paths cannot leave the files folder", async () => {
  await assert.rejects(files.read("demo", "../project.json"), /outside the project files folder/);
  await assert.rejects(files.write("demo", "/etc/hosts", "x"), /relative to the project files folder/);
  await assert.rejects(files.write("demo", "", "x"), /path is required/);
  const outside = join(home, "outside");
  await mkdir(outside);
  await symlink(outside, join(files.root("demo"), "escape"));
  await assert.rejects(files.write("demo", "escape/secret.txt", "x"), /outside the project files folder/);
  assert.ok(!(await files.list("demo")).some((file) => file.path.startsWith("escape")));
});

test("binary files are listed but not opened", async () => {
  await writeFile(join(files.root("demo"), "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  assert.ok((await files.list("demo")).some((file) => file.path === "logo.png"));
  await assert.rejects(files.read("demo", "logo.png"), /binary file/);
});

test("changes made outside borkcode are broadcast", async () => {
  files.watch("demo");
  const changed = new Promise<ProjectFile[]>((resolve) => {
    onChange = (project, list) => {
      if (project === "demo" && list.some((file) => file.path === "from-agent.md")) resolve(list);
    };
  });
  await writeFile(join(files.root("demo"), "from-agent.md"), "hello\n");
  assert.ok((await changed).some((file) => file.path === "from-agent.md"));
});
