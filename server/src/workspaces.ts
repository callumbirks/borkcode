import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Project, PullRequestRef, RepoConfig, RepoStatus } from "shared/protocol";
import { git, run, runShell } from "./exec.ts";

// A workspace is a folder holding one checkout of every project repo as siblings, named exactly
// like the main clones in repos/. Thread workspaces live in worktrees/<name>/ and hold git
// worktrees on a shared branch; `null` means the main clones themselves.

export function workspacePath(project: Project, workspace: string | null): string {
  return workspace === null
    ? join(project.path, "repos")
    : join(project.path, "worktrees", workspace);
}

export function mainRepoPath(project: Project, repo: RepoConfig): string {
  return join(project.path, "repos", repo.name);
}

export class WorkspaceDirtyError extends Error {
  readonly repos: string[];
  constructor(repos: string[]) {
    super(`Uncommitted changes in ${repos.join(", ")}`);
    this.repos = repos;
  }
}

/** Prefers the remote-tracking base so new branches start from upstream, not a stale local branch. */
async function resolveBaseRef(repoDir: string, baseBranch: string): Promise<string> {
  try {
    await git(repoDir, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${baseBranch}`);
    return `origin/${baseBranch}`;
  } catch {
    return baseBranch;
  }
}

async function branchExists(repoDir: string, branch: string): Promise<boolean> {
  try {
    await git(repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Adds a worktree for every project repo missing from the workspace. Idempotent, so it also
 * picks up repos added to the project after the workspace was created. Returns the new repos.
 */
export async function ensureWorkspace(
  project: Project,
  workspace: string,
  branch: string,
): Promise<RepoConfig[]> {
  const root = workspacePath(project, workspace);
  await mkdir(root, { recursive: true });
  const created: RepoConfig[] = [];
  for (const repo of project.repos) {
    const target = join(root, repo.name);
    if (existsSync(target)) continue;
    const mainDir = mainRepoPath(project, repo);
    if (await branchExists(mainDir, branch)) {
      await git(mainDir, "worktree", "add", target, branch);
    } else {
      await git(mainDir, "fetch", "origin", repo.baseBranch).catch(() => undefined);
      const baseRef = await resolveBaseRef(mainDir, repo.baseBranch);
      await git(mainDir, "worktree", "add", "--no-track", "-b", branch, target, baseRef);
    }
    created.push(repo);
  }
  return created;
}

export function runRepoSetup(project: Project, workspace: string, repo: RepoConfig) {
  const root = workspacePath(project, workspace);
  return runShell(repo.setup ?? "true", {
    cwd: join(root, repo.name),
    env: {
      ...process.env,
      BORKCODE_PROJECT: project.path,
      BORKCODE_WORKSPACE: root,
      BORKCODE_MAIN_REPO: mainRepoPath(project, repo),
    },
  });
}

export async function dirtyRepos(project: Project, workspace: string | null): Promise<string[]> {
  const root = workspacePath(project, workspace);
  const dirty: string[] = [];
  for (const repo of project.repos) {
    const dir = join(root, repo.name);
    if (!existsSync(dir)) continue;
    if ((await git(dir, "status", "--porcelain")).length > 0) dirty.push(repo.name);
  }
  return dirty;
}

/** Removes a thread workspace and its worktrees. Branches are kept. */
export async function removeWorkspace(
  project: Project,
  workspace: string,
  force: boolean,
): Promise<void> {
  if (!force) {
    const dirty = await dirtyRepos(project, workspace);
    if (dirty.length > 0) throw new WorkspaceDirtyError(dirty);
  }
  const root = workspacePath(project, workspace);
  for (const repo of project.repos) {
    const target = join(root, repo.name);
    if (!existsSync(target)) continue;
    await git(mainRepoPath(project, repo), "worktree", "remove", "--force", target);
  }
  await rm(root, { recursive: true, force: true });
  for (const repo of project.repos) {
    await git(mainRepoPath(project, repo), "worktree", "prune").catch(() => undefined);
  }
}

export async function repoStatuses(
  project: Project,
  workspace: string | null,
): Promise<RepoStatus[]> {
  const root = workspacePath(project, workspace);
  return Promise.all(
    project.repos.map(async (repo): Promise<RepoStatus> => {
      const path = join(root, repo.name);
      const status: RepoStatus = {
        name: repo.name,
        path,
        exists: existsSync(path),
        branch: null,
        baseBranch: repo.baseBranch,
        changedFiles: [],
        ahead: null,
        pullRequest: null,
      };
      if (!status.exists) return status;
      status.branch = await git(path, "rev-parse", "--abbrev-ref", "HEAD");
      status.changedFiles = (await git(path, "status", "--porcelain"))
        .split("\n")
        .filter((line) => line.length > 0);
      const baseRef = await resolveBaseRef(path, repo.baseBranch);
      status.ahead = Number(
        await git(path, "rev-list", "--count", `${baseRef}..HEAD`).catch(() => "NaN"),
      );
      if (Number.isNaN(status.ahead)) status.ahead = null;
      if (status.branch !== repo.baseBranch && status.branch !== "HEAD") {
        status.pullRequest = await findPullRequest(path, status.branch);
      }
      return status;
    }),
  );
}

async function findPullRequest(repoDir: string, branch: string): Promise<PullRequestRef | null> {
  try {
    const output = await run(
      "gh",
      ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "number,url,state,title"],
      { cwd: repoDir },
    );
    const [pr] = JSON.parse(output) as PullRequestRef[];
    return pr ?? null;
  } catch {
    // Not a GitHub remote, gh missing, or offline. PR display is best-effort.
    return null;
  }
}
