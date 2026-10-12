import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FileMention, Mention, Project, Thread, ThreadMention } from "shared/protocol";
import { git } from "./exec.ts";
import type { FileStore } from "./files.ts";

const MAX_RESULTS = 50;
/** The picker searches on every pause in typing, so a repo is listed at most this often. */
const LISTING_TTL_MS = 10_000;

/**
 * Ranks a path against what was typed after `@`; lower is better, null is no match. Matches on
 * the file name beat matches spread over the folders, and shorter paths win ties, so an empty
 * query lists the shallowest files first.
 */
export function matchScore(query: string, path: string): number | null {
  const q = query.toLowerCase();
  const full = path.toLowerCase();
  const name = full.slice(full.lastIndexOf("/") + 1);
  let tier: number;
  if (name === q) tier = 0;
  else if (name.startsWith(q)) tier = 1;
  else if (name.includes(q)) tier = 2;
  else if (full.includes(q)) tier = 3;
  else if (isSubsequence(q, name)) tier = 4;
  else if (isSubsequence(q, full)) tier = 5;
  else return null;
  return tier * 100_000 + path.length;
}

function isSubsequence(query: string, text: string): boolean {
  let at = 0;
  for (const char of query) {
    at = text.indexOf(char, at) + 1;
    if (at === 0) return false;
  }
  return true;
}

/**
 * Claude Code reads `@path` in a prompt as a file reference and quotes paths with spaces as
 * `@"path"`; Codex passes the text through, and the model reads the file itself.
 */
export function fileReference(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

/** Mixed matches stay project-scoped; thread mode includes all projects, local matches first. */
export function threadMentions(
  threads: Thread[], project: string, current: string, query: string, mode: "mixed" | "threads" = "mixed",
): ThreadMention[] {
  return threads
    .filter(t => (mode === "threads" || t.project === project) && t.id !== current && t.archivedAt === null && matchScore(query, t.title) !== null)
    .sort((a, b) => mode === "threads"
      ? Number(b.project === project) - Number(a.project === project) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
      : matchScore(query, a.title)! - matchScore(query, b.title)! || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    .slice(0, mode === "threads" ? MAX_RESULTS : 10)
    .map(t => ({ kind: "thread", threadId: t.id, title: t.title, project: t.project,
      status: t.status, reference: `borkcode:thread:${t.id}` }));
}

/** Offers other active threads, workspace files and the project's shared files in the @ picker. */
export class MentionSearch {
  readonly #files: FileStore;
  readonly #locate: (threadId: string) => Promise<{ project: Project; root: string }>;
  readonly #threads: () => Thread[];
  readonly #listings = new Map<string, { at: number; paths: Promise<string[]> }>();

  constructor(files: FileStore, locate: (threadId: string) => Promise<{ project: Project; root: string }>, threads: () => Thread[] = () => []) {
    this.#files = files;
    this.#threads = threads;
    this.#locate = locate;
  }

  async search(threadId: string, query: string, mode: "mixed" | "threads" = "mixed"): Promise<Mention[]> {
    const { project, root } = await this.#locate(threadId);
    if (mode === "threads") return threadMentions(this.#threads(), project.name, threadId, query, mode);
    const filesRoot = this.#files.root(project.name);
    const matches: { score: number; match: string; mention: FileMention }[] = [];
    const consider = (match: string, mention: FileMention) => {
      const score = matchScore(query, match);
      if (score !== null) matches.push({ score, match, mention });
    };
    const [projectFiles, ...repoFiles] = await Promise.all([
      this.#files.list(project.name),
      ...project.repos.map((repo) => this.#listRepo(join(root, repo.name))),
    ]);
    for (const file of projectFiles) {
      const reference = fileReference(join(filesRoot, file.path));
      consider(file.path, { kind: "file", repo: null, path: file.path, reference });
    }
    project.repos.forEach((repo, index) => {
      for (const path of repoFiles[index]) {
        const match = `${repo.name}/${path}`;
        consider(match, { kind: "file", repo: repo.name, path, reference: fileReference(match) });
      }
    });
    // Keep a short thread group above files so even a repo with thousands of paths offers threads.
    const threads = query ? threadMentions(this.#threads(), project.name, threadId, query) : [];
    const rankedFiles = matches
      .sort((a, b) => a.score - b.score || a.match.localeCompare(b.match))
      .slice(0, MAX_RESULTS - threads.length)
      .map((entry) => entry.mention);
    return [...threads, ...rankedFiles];
  }

  /** Tracked and untracked files, skipping ignored ones. Repos not checked out yet list nothing. */
  #listRepo(dir: string): Promise<string[]> {
    const now = Date.now();
    for (const [key, listing] of this.#listings) {
      if (now - listing.at > LISTING_TTL_MS) this.#listings.delete(key);
    }
    const cached = this.#listings.get(dir);
    if (cached) return cached.paths;
    if (!existsSync(dir)) return Promise.resolve([]);
    const paths = git(dir, "ls-files", "--cached", "--others", "--exclude-standard", "-z").then(
      (output) => [...new Set(output.split("\0").filter((path) => path.length > 0))],
      (error: Error) => {
        this.#listings.delete(dir);
        console.error(`Could not list files in ${dir}: ${error.message}`);
        return [];
      },
    );
    this.#listings.set(dir, { at: now, paths });
    return paths;
  }
}
