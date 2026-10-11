import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { git } from "./exec.ts";
import { ProjectStore } from "./projects.ts";
import {
  dirtyRepos,
  ensureWorkspace,
  removeWorkspace,
  repoStatuses,
  runRepoSetup,
  WorkspaceDirtyError,
  workspacePath,
} from "./workspaces.ts";

let scratch: string;
let store: ProjectStore;

async function makeOrigin(name: string, branch = "main"): Promise<string> {
  const dir = join(scratch, "origins", name);
  await git(scratch, "init", "-q", "-b", branch, dir);
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "test");
  await writeFile(join(dir, "README.md"), `# ${name}\n`);
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", "init");
  return dir;
}

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "borkcode-test-"));
  store = new ProjectStore(join(scratch, "home"));
  await store.create("doofcraft");
  await store.addRepo("doofcraft", await makeOrigin("doofcraft"));
  await store.addRepo("doofcraft", await makeOrigin("vessel-src", "trunk"), "vessel");
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test("adding repos records names and detected base branches", async () => {
  const project = await store.get("doofcraft");
  assert.deepEqual(
    project.repos.map((repo) => [repo.name, repo.baseBranch]),
    [
      ["doofcraft", "main"],
      ["vessel", "trunk"],
    ],
  );
  assert.ok(existsSync(join(project.path, "repos", "vessel", "README.md")));
});

test("a workspace holds sibling worktrees of every repo on one branch", async () => {
  const project = await store.get("doofcraft");
  const created = await ensureWorkspace(project, "fix-a1", "borkcode/fix-a1");
  assert.deepEqual(
    created.map((repo) => repo.name),
    ["doofcraft", "vessel"],
  );

  const root = workspacePath(project, "fix-a1");
  for (const name of ["doofcraft", "vessel"]) {
    assert.equal(await git(join(root, name), "rev-parse", "--abbrev-ref", "HEAD"), "borkcode/fix-a1");
  }
  // Sibling-relative paths resolve inside the workspace.
  assert.equal(
    await readFile(join(root, "doofcraft", "..", "vessel", "README.md"), "utf8"),
    "# vessel-src\n",
  );
  // Main clones stay on their base branches.
  assert.equal(await git(join(project.path, "repos", "vessel"), "rev-parse", "--abbrev-ref", "HEAD"), "trunk");

  assert.deepEqual(await ensureWorkspace(project, "fix-a1", "borkcode/fix-a1"), []);
});

test("repos added later are filled into existing workspaces", async () => {
  await store.create("late");
  await store.addRepo("late", await makeOrigin("first"));
  await ensureWorkspace(await store.get("late"), "ws", "borkcode/ws");
  await store.addRepo("late", await makeOrigin("second"));
  const created = await ensureWorkspace(await store.get("late"), "ws", "borkcode/ws");
  assert.deepEqual(
    created.map((repo) => repo.name),
    ["second"],
  );
});

test("status reports changes and commits ahead per repo", async () => {
  const project = await store.get("doofcraft");
  const vessel = join(workspacePath(project, "fix-a1"), "vessel");
  await git(vessel, "config", "user.email", "test@example.com");
  await git(vessel, "config", "user.name", "test");
  await writeFile(join(vessel, "change.txt"), "x\n");
  await git(vessel, "add", ".");
  await git(vessel, "commit", "-q", "-m", "change");
  await writeFile(join(vessel, "dirty.txt"), "x\n");

  const statuses = await repoStatuses(project, "fix-a1");
  const byName = Object.fromEntries(statuses.map((status) => [status.name, status]));
  assert.equal(byName.doofcraft.ahead, 0);
  assert.deepEqual(byName.doofcraft.changedFiles, []);
  assert.equal(byName.vessel.ahead, 1);
  assert.deepEqual(byName.vessel.changedFiles, ["?? dirty.txt"]);
});

test("setup scripts run in the worktree with project paths in the environment", async () => {
  const project = await store.updateRepo("doofcraft", "doofcraft", {
    setup: 'cp "$BORKCODE_MAIN_REPO/README.md" copied.md && echo done',
  });
  const result = await runRepoSetup(project, "fix-a1", project.repos[0]);
  assert.equal(result.code, 0);
  assert.equal(result.output.trim(), "done");
  assert.ok(existsSync(join(workspacePath(project, "fix-a1"), "doofcraft", "copied.md")));
});

test("removing a dirty workspace requires force and keeps branches", async () => {
  const project = await store.get("doofcraft");
  assert.deepEqual(await dirtyRepos(project, "fix-a1"), ["doofcraft", "vessel"]);
  await assert.rejects(removeWorkspace(project, "fix-a1", false), WorkspaceDirtyError);

  await removeWorkspace(project, "fix-a1", true);
  assert.equal(existsSync(workspacePath(project, "fix-a1")), false);
  const vesselMain = join(project.path, "repos", "vessel");
  assert.equal(await git(vesselMain, "branch", "--list", "borkcode/fix-a1"), "  borkcode/fix-a1");

  // Recreating the workspace checks out the kept branch, commits included.
  await ensureWorkspace(project, "fix-a1", "borkcode/fix-a1");
  const statuses = await repoStatuses(project, "fix-a1");
  assert.equal(statuses.find((status) => status.name === "vessel")?.ahead, 1);
});
