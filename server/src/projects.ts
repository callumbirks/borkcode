import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Project, RepoConfig } from "shared/protocol";
import { git } from "./exec.ts";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertValidName(kind: string, name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`${kind} name "${name}" may only contain letters, digits, ".", "_" and "-"`);
  }
}

/** Expands GitHub `owner/repo` shorthand; other values are passed to git as-is. */
export function normalizeRepoUrl(url: string): string {
  const trimmed = url.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) return `https://github.com/${trimmed}.git`;
  return trimmed;
}

export function repoNameFromUrl(url: string): string {
  return basename(url.replace(/\/+$/, "")).replace(/\.git$/, "");
}

interface ProjectFile {
  description?: string;
  repos: RepoConfig[];
}

/**
 * Projects live on disk as `<home>/projects/<name>/` with a project.json describing their repos.
 * The folder is the source of truth, so hand edits to project.json are picked up.
 */
export class ProjectStore {
  readonly root: string;

  constructor(home: string) {
    this.root = join(home, "projects");
  }

  projectPath(name: string): string {
    return join(this.root, name);
  }

  async list(): Promise<Project[]> {
    if (!existsSync(this.root)) return [];
    const entries = await readdir(this.root, { withFileTypes: true });
    const projects: Project[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!existsSync(join(this.root, entry.name, "project.json"))) continue;
      projects.push(await this.get(entry.name));
    }
    return projects.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(name: string): Promise<Project> {
    assertValidName("Project", name);
    const path = this.projectPath(name);
    const file = JSON.parse(await readFile(join(path, "project.json"), "utf8")) as ProjectFile;
    return { name, path, repos: file.repos ?? [], ...(file.description ? { description: file.description } : {}) };
  }

  async create(name: string): Promise<Project> {
    assertValidName("Project", name);
    const path = this.projectPath(name);
    if (existsSync(join(path, "project.json"))) throw new Error(`Project "${name}" already exists`);
    for (const dir of ["files", "repos", "worktrees"]) {
      await mkdir(join(path, dir), { recursive: true });
    }
    await this.#write({ name, path, repos: [] });
    return this.get(name);
  }

  async addRepo(projectName: string, rawUrl: string, rawName?: string): Promise<Project> {
    const project = await this.get(projectName);
    const url = normalizeRepoUrl(rawUrl);
    const name = rawName?.trim() || repoNameFromUrl(url);
    assertValidName("Repository", name);
    if (project.repos.some((repo) => repo.name === name)) {
      throw new Error(`Project "${projectName}" already has a repository named "${name}"`);
    }
    const target = join(project.path, "repos", name);
    if (existsSync(target)) throw new Error(`${target} already exists`);
    await git(join(project.path, "repos"), "clone", url, name);
    const baseBranch = await detectDefaultBranch(target);
    project.repos.push({ name, url, baseBranch });
    await this.#write(project);
    return project;
  }

  async updateRepo(
    projectName: string,
    name: string,
    patch: { baseBranch?: string; setup?: string },
  ): Promise<Project> {
    const project = await this.get(projectName);
    const repo = project.repos.find((candidate) => candidate.name === name);
    if (!repo) throw new Error(`Unknown repository "${name}"`);
    if (patch.baseBranch !== undefined) repo.baseBranch = patch.baseBranch.trim();
    if (patch.setup !== undefined) {
      const setup = patch.setup.trim();
      if (setup) repo.setup = setup;
      else delete repo.setup;
    }
    await this.#write(project);
    return project;
  }

  async #write(project: Project): Promise<void> {
    const file: ProjectFile = { repos: project.repos, ...(project.description ? { description: project.description } : {}) };
    await writeFile(join(project.path, "project.json"), `${JSON.stringify(file, null, 2)}\n`);
  }
}

async function detectDefaultBranch(repoDir: string): Promise<string> {
  try {
    const ref = await git(repoDir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
    return ref.replace(/^origin\//, "");
  } catch {
    return git(repoDir, "rev-parse", "--abbrev-ref", "HEAD");
  }
}
