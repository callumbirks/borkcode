import { existsSync, mkdirSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { ProjectFile } from "shared/protocol";
import { ToolError } from "./errors.ts";
import type { ProjectStore } from "./projects.ts";

/** Larger files are listed but not opened; the folder is for notes and specs, not assets. */
const MAX_READ_BYTES = 1024 * 1024;
/** Collapses a burst of filesystem events, such as an editor's save, into one broadcast. */
const CHANGE_SETTLE_MS = 150;

/**
 * Each project's `files/` folder, shared by its threads and the user. Agents may also edit it with
 * their own file tools, so changes are picked up by watching the folder rather than by tracking
 * writes made here.
 */
export class FileStore {
  readonly #projects: ProjectStore;
  readonly #onChange: (project: string, files: ProjectFile[]) => void;
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #pending = new Map<string, NodeJS.Timeout>();

  constructor(projects: ProjectStore, onChange: (project: string, files: ProjectFile[]) => void) {
    this.#projects = projects;
    this.#onChange = onChange;
  }

  root(project: string): string {
    return join(this.#projects.projectPath(project), "files");
  }

  async list(project: string): Promise<ProjectFile[]> {
    await this.#projects.get(project);
    const root = this.root(project);
    await mkdir(root, { recursive: true });
    const files: ProjectFile[] = [];
    await walk(root, root, files);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(project: string, path: string): Promise<{ content: string; modifiedAt: number }> {
    const full = await this.#resolve(project, path);
    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) throw new ToolError(`There is no project file ${path}.`);
    if (info.size > MAX_READ_BYTES) throw new ToolError(`${path} is larger than 1 MB, too big to open here.`);
    const bytes = await readFile(full);
    if (bytes.includes(0)) throw new ToolError(`${path} is a binary file.`);
    return { content: bytes.toString("utf8"), modifiedAt: info.mtimeMs };
  }

  /**
   * Creates or replaces a file, creating folders as needed. With `expectedModifiedAt`, refuses if
   * the file changed in the meantime (null: if it exists at all); undefined skips the check.
   */
  async write(
    project: string,
    path: string,
    content: string,
    expectedModifiedAt?: number | null,
  ): Promise<ProjectFile> {
    const full = await this.#resolve(project, path);
    const current = await stat(full).catch(() => null);
    if (current?.isDirectory()) throw new ToolError(`${path} is a folder.`);
    if (expectedModifiedAt === null && current) throw new ToolError(`${path} already exists.`);
    if (typeof expectedModifiedAt === "number" && current?.mtimeMs !== expectedModifiedAt) {
      throw new ToolError(`${path} changed since it was opened. Reload it before saving.`);
    }
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
    const written = await stat(full);
    return { path: toProjectPath(this.root(project), full), size: written.size, modifiedAt: written.mtimeMs };
  }

  async delete(project: string, path: string): Promise<void> {
    const full = await this.#resolve(project, path);
    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) throw new ToolError(`There is no project file ${path}.`);
    await rm(full);
    await this.#pruneEmptyFolders(project, dirname(full));
  }

  /** Removes a folder and everything in it. Returns how many files went with it. */
  async deleteFolder(project: string, path: string): Promise<number> {
    const full = await this.#resolve(project, path);
    const info = await stat(full).catch(() => null);
    if (!info?.isDirectory()) throw new ToolError(`There is no project folder ${path}.`);
    const files: ProjectFile[] = [];
    await walk(full, full, files);
    await rm(full, { recursive: true });
    await this.#pruneEmptyFolders(project, dirname(full));
    return files.length;
  }

  /** The list shows files only, so folders emptied by a delete would linger unseen. */
  async #pruneEmptyFolders(project: string, dir: string): Promise<void> {
    const root = this.root(project);
    for (let current = dir; current.startsWith(root + sep); current = dirname(current)) {
      if ((await readdir(current)).length > 0) return;
      await rmdir(current);
    }
  }

  /** Broadcasts the project's file list whenever its folder changes. Safe to call repeatedly. */
  watch(project: string): void {
    if (this.#watchers.has(project)) return;
    const root = this.root(project);
    mkdirSync(root, { recursive: true });
    const watcher = watch(root, { recursive: true }, () => this.#changed(project));
    // The folder went away, for example with its project; a later list or write starts over.
    watcher.on("error", () => {
      watcher.close();
      this.#watchers.delete(project);
    });
    this.#watchers.set(project, watcher);
  }

  async watchAll(): Promise<void> {
    for (const project of await this.#projects.list()) this.watch(project.name);
  }

  #changed(project: string): void {
    clearTimeout(this.#pending.get(project));
    this.#pending.set(
      project,
      setTimeout(() => {
        this.#pending.delete(project);
        this.list(project).then(
          (files) => this.#onChange(project, files),
          (error: Error) => console.error(`Could not list files of ${project}: ${error.message}`),
        );
      }, CHANGE_SETTLE_MS),
    );
  }

  /** Maps a relative path into the folder, refusing anything that would land outside it. */
  async #resolve(project: string, path: string): Promise<string> {
    await this.#projects.get(project);
    if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
      throw new ToolError(`Use a path relative to the project files folder, not ${path}.`);
    }
    const segments = path.split(/[\\/]+/).filter((segment) => segment && segment !== ".");
    if (segments.length === 0) throw new ToolError("A file path is required.");
    if (segments.includes("..")) throw new ToolError(`${path} points outside the project files folder.`);
    const root = this.root(project);
    await mkdir(root, { recursive: true });
    const full = join(root, ...segments);
    // A symlink inside the folder could otherwise lead out of it.
    let existing = full;
    while (!existsSync(existing)) existing = dirname(existing);
    const [realRoot, real] = await Promise.all([realpath(root), realpath(existing)]);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new ToolError(`${path} points outside the project files folder.`);
    }
    return full;
  }
}

function toProjectPath(root: string, full: string): string {
  return relative(root, full).split(sep).join("/");
}

/** Lists regular files only; symlinks are skipped so the listing never leaves the folder. */
async function walk(root: string, dir: string, files: ProjectFile[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, files);
    } else if (entry.isFile()) {
      const info = await stat(full);
      files.push({ path: toProjectPath(root, full), size: info.size, modifiedAt: info.mtimeMs });
    }
  }
}
