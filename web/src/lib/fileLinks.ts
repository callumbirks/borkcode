import type { FileRoot, FileTarget } from "shared/protocol";

export interface LineRange {
  start: number;
  end: number;
}

/** What the preview panel shows: a file or folder, and the lines to scroll to, if any. */
export interface PreviewTarget {
  root: FileRoot;
  path: string;
  lines: LineRange | null;
}

/**
 * Turns paths in rendered text into links. `find` answers from what the server has located so far
 * and asks it about paths it hasn't seen; null means not a file of this thread, or not known yet.
 */
export interface FileLinker {
  find(path: string): FileTarget | null;
  href(target: { root: FileRoot; path: string }): string;
}

/** The endpoint that serves a thread's files to the preview, by root and relative path. */
export function fileUrl(threadId: string, target: { root: FileRoot; path: string }): string {
  return `/api/threads/${threadId}/files?root=${target.root}&path=${encodeURIComponent(target.path)}`;
}

/** How a file is shown to the user, like the chips: repo first, or under "Project files". */
export function targetLabel(target: { root: FileRoot; path: string }): string {
  return target.root === "project" ? `Project files/${target.path}` : target.path;
}

/** The inverse of `targetLabel`, for chips, whose labels are made by `labelFor`. */
export function labelTarget(label: string): { root: FileRoot; path: string } {
  return label.startsWith("Project files/")
    ? { root: "project", path: label.slice("Project files/".length) }
    : { root: "workspace", path: label };
}

// `path:42`, `path:42-50`, `path:42:7` (a column, dropped) and GitHub's `path#L42-L50`.
const LINE_SUFFIX = /(?::(\d+)(?:-(\d+))?(?::\d+)?|#L(\d+)(?:-L?(\d+))?)$/;

/** Splits a trailing line or line range off a path. */
export function splitLines(text: string): { path: string; lines: LineRange | null } {
  const match = LINE_SUFFIX.exec(text);
  if (!match || match.index === 0) return { path: text, lines: null };
  const start = Number(match[1] ?? match[3]);
  const end = Number(match[2] ?? match[4] ?? start);
  if (start < 1) return { path: text.slice(0, match.index), lines: null };
  return { path: text.slice(0, match.index), lines: { start, end: Math.max(start, end) } };
}

export function formatLines(lines: LineRange | null): string {
  if (!lines) return "";
  return lines.end > lines.start ? `:${lines.start}-${lines.end}` : `:${lines.start}`;
}

/**
 * The path in an inline code span, if it could be one: a single token with a slash or a file
 * extension, not a URL or a flag. Whether it names a file is for the server to say.
 */
export function codePath(code: string): { path: string; lines: LineRange | null } | null {
  const text = code.trim();
  if (!text || text.length > 400 || /\s/.test(text) || text.includes("://") || /^[-~$<]/.test(text)) return null;
  const split = splitLines(text);
  if (!split.path.includes("/") && !/\.[A-Za-z0-9]{1,10}$/.test(split.path)) return null;
  return split;
}

/**
 * Paths written in prose: at least one folder and a file name with an extension, optionally
 * absolute or `./`-relative, with a line suffix. Not inside a word, URL or other path.
 */
export const BARE_PATH =
  /(?<![\w/.:@~#-])(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w-][\w.-]*\.(?=[A-Za-z0-9]{0,9}[A-Za-z])[A-Za-z0-9]{1,10}(?::\d+(?:-\d+)?)?(?![\w/])/g;

/** Bare paths in text, with where each starts and ends. Sentence punctuation is left out. */
export function findBarePaths(text: string): { start: number; end: number; path: string; lines: LineRange | null }[] {
  return [...text.matchAll(BARE_PATH)].map((match) => {
    const raw = match[0].replace(/\.+$/, "");
    return { start: match.index, end: match.index + raw.length, ...splitLines(raw) };
  });
}

/**
 * The files a tool call works on, from its summary. Claude's Read, Edit and Write summarize as
 * their `file_path`; Codex's file changes as their paths joined with ", ".
 */
export function toolPaths(name: string, summary: string): string[] {
  if (!summary) return [];
  if (name === "edit") return summary.split(", ");
  return ["Read", "Write", "Edit", "MultiEdit"].includes(name) ? [summary] : [];
}
