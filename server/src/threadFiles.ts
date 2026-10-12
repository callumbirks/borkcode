import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import type { FileRoot, FileTarget } from "shared/protocol";

/** Text past this is cut off; the preview says so. */
export const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_LOCATE_PATHS = 200;
/** Looked at for a NUL byte to tell binary files from text, like git does. */
const SNIFF_BYTES = 8000;

/** Shown as images. SVG is left out on purpose: it can carry script, so it is served as text. */
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

export function imageType(path: string): string | null {
  return IMAGE_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? null;
}

/** The folders a thread's previews may read from. */
export interface PreviewRoots {
  workspace: string;
  project: string;
  /** Repo folder names in the workspace, tried as bases for paths written relative to a repo. */
  repos: string[];
}

export class PreviewError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Maps a path relative to a root onto the disk, or null when it does not exist or would leave the
 * root, including through `..` or a symlink. Git's own folders are never served.
 */
export async function resolveIn(
  base: string,
  path: string,
): Promise<{ full: string; path: string; kind: FileTarget["kind"] } | null> {
  if (path.includes("\0") || isAbsolute(path) || /^[A-Za-z]:/.test(path)) return null;
  const segments = path.split(/[\\/]+/).filter((segment) => segment && segment !== ".");
  if (segments.includes("..") || segments.some(isGitSegment)) return null;
  const full = join(base, ...segments);
  try {
    const [realBase, real] = await Promise.all([realpath(base), realpath(full)]);
    if (real !== realBase && !real.startsWith(realBase + sep)) return null;
    if (real.slice(realBase.length).split(sep).some(isGitSegment)) return null;
    const info = await stat(real);
    if (!info.isFile() && !info.isDirectory()) return null;
    return { full: real, path: segments.join("/"), kind: info.isDirectory() ? "directory" : "file" };
  } catch {
    return null;
  }
}

function isGitSegment(segment: string): boolean {
  return segment.toLowerCase() === ".git";
}

function rootDir(roots: PreviewRoots, root: FileRoot): string {
  return root === "project" ? roots.project : roots.workspace;
}

/**
 * Finds what a path written in a transcript points at. Agents write absolute paths, paths from
 * the workspace root (their cwd), and paths from inside a repo, so each is tried in turn.
 */
export async function locate(roots: PreviewRoots, written: string): Promise<FileTarget | null> {
  const path = written.trim().replace(/(.)\/+$/, "$1");
  if (path.split("/").every((segment) => segment === "" || segment === ".")) return null;
  const attempts: { root: FileRoot; path: string }[] = [];
  if (isAbsolute(path)) {
    for (const root of ["project", "workspace"] as const) {
      const base = rootDir(roots, root);
      if (path === base || path.startsWith(base + "/")) attempts.push({ root, path: path.slice(base.length + 1) });
    }
  } else {
    attempts.push({ root: "workspace", path });
    for (const repo of roots.repos) attempts.push({ root: "workspace", path: `${repo}/${path}` });
    attempts.push({ root: "project", path });
  }
  for (const attempt of attempts) {
    const found = await resolveIn(rootDir(roots, attempt.root), attempt.path);
    // The workspace root itself is no use as a link.
    if (found && found.path) return { root: attempt.root, path: found.path, kind: found.kind };
  }
  return null;
}

export async function locateAll(roots: PreviewRoots, paths: string[]): Promise<(FileTarget | null)[]> {
  if (paths.length > MAX_LOCATE_PATHS) throw new Error(`At most ${MAX_LOCATE_PATHS} paths at a time`);
  return Promise.all(paths.map((path) => locate(roots, path)));
}

export type Preview =
  | { kind: "directory"; entries: { name: string; kind: FileTarget["kind"] }[] }
  | { kind: "image"; full: string; mimeType: string; size: number }
  | { kind: "text"; text: Buffer; size: number; truncated: boolean };

/** What the preview endpoint serves for a path under one of the thread's roots. */
export async function readPreview(roots: PreviewRoots, root: FileRoot, path: string): Promise<Preview> {
  const found = await resolveIn(rootDir(roots, root), path);
  if (!found) throw new PreviewError(404, "There is no such file in this thread's workspace");
  if (found.kind === "directory") {
    const entries = (await readdir(found.full, { withFileTypes: true }))
      .filter((entry) => !isGitSegment(entry.name) && (entry.isFile() || entry.isDirectory()))
      .map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? ("directory" as const) : ("file" as const) }))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));
    return { kind: "directory", entries };
  }
  const { size } = await stat(found.full);
  const mimeType = imageType(found.full);
  if (mimeType) return { kind: "image", full: found.full, mimeType, size };
  const handle = await open(found.full);
  try {
    const buffer = Buffer.alloc(Math.min(size, MAX_TEXT_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead);
    if (text.subarray(0, SNIFF_BYTES).includes(0)) throw new PreviewError(415, "This is a binary file");
    return { kind: "text", text, size, truncated: size > bytesRead };
  } finally {
    await handle.close();
  }
}
