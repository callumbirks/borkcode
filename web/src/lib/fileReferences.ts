import type { Project } from "shared/protocol";

/** What a thread's file references can point into. */
export interface ReferenceRoots {
  repos: string[];
  /** The thread's workspace root, for references written as absolute paths. */
  workspace: string;
  /** The project's shared files folder; the picker inserts these files by absolute path. */
  projectFiles: string;
}

/** A file reference found in text, such as `@borkcode/server/src/main.ts`. */
export interface FileReference {
  start: number;
  end: number;
  /** The file name, shown on the chip. */
  name: string;
  /** A path that never reveals the machine's folders: `<repo>/<path>` or `Project files/<path>`. */
  label: string;
}

export function referenceRoots(project: Project | undefined, workspace: string | undefined): ReferenceRoots | null {
  if (!project || !workspace) return null;
  return { repos: project.repos.map((repo) => repo.name), workspace, projectFiles: `${project.path}/files` };
}

// The forms the picker inserts: `@path`, or `@"path"` when it has spaces, after a boundary.
const REFERENCE = /(?<=^|\s)@(?:"([^"\n]+)"|(\S+))/g;
/** Sentence punctuation right after an unquoted reference isn't part of the path. */
const TRAILING = /[.,;:!?)\]]+$/;

/** The display label for a referenced path, or null when it isn't a file this thread knows. */
export function labelFor(path: string, roots: ReferenceRoots): string | null {
  const relative = (root: string) => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null);
  const projectFile = relative(roots.projectFiles);
  if (projectFile) return `Project files/${projectFile}`;
  const inRepos = relative(roots.workspace) ?? (path.startsWith("/") ? null : path);
  if (!inRepos) return null;
  const slash = inRepos.indexOf("/");
  if (slash <= 0 || slash === inRepos.length - 1) return null;
  return roots.repos.includes(inRepos.slice(0, slash)) ? inRepos : null;
}

/** File references in text that resolve to one of the thread's repos or its project files. */
export function findFileReferences(text: string, roots: ReferenceRoots): FileReference[] {
  const found: FileReference[] = [];
  for (const match of text.matchAll(REFERENCE)) {
    const quoted = match[1];
    const path = quoted ?? match[2].replace(TRAILING, "");
    const label = labelFor(path, roots);
    if (!label) continue;
    const length = quoted ? match[0].length : path.length + 1;
    found.push({ start: match.index, end: match.index + length, name: label.slice(label.lastIndexOf("/") + 1), label });
  }
  return found;
}

/** Text split around its references, for rendering them as chips. */
export function splitReferences(
  text: string,
  references: FileReference[],
): { text: string; reference: FileReference | null }[] {
  const parts: { text: string; reference: FileReference | null }[] = [];
  let at = 0;
  for (const reference of references) {
    if (reference.start > at) parts.push({ text: text.slice(at, reference.start), reference: null });
    parts.push({ text: text.slice(reference.start, reference.end), reference });
    at = reference.end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), reference: null });
  return parts;
}
