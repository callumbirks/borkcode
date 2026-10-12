import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import type { FileRoot } from "shared/protocol";
import { isId, type AttachmentStore } from "./attachments.ts";
import { ToolError } from "./errors.ts";
import { resolveIn, type PreviewRoots } from "./threadFiles.ts";

export const MAX_VISUALIZATION_BYTES = 2 * 1024 * 1024;

/**
 * Visualizations are agent-written HTML with scripts, so they run sandboxed in an opaque origin:
 * they cannot read borkcode's pages, and their requests to `/api` and `/ws` carry `Origin: null`,
 * which is refused. Scripts, styles, images, fonts and fetches may come from any `https:` host,
 * since agents load chart libraries from CDNs; plain `http:` stays closed. Requests to borkcode
 * outside the asset route are refused by Origin or Sec-Fetch-Site even over HTTPS, including
 * script/image requests that carry no Origin.
 *
 * A page shown from a file may also load from `assetBase`, its own asset route
 * (`<scheme>://<host>/api/threads/<thread>/visualizations/<id>/`). It uses HTTPS for the configured
 * tailnet hostname and HTTP locally. The full path scopes the exception; `'self'` is unreliable
 * for an opaque origin and would open all of `/api`.
 */
export function visualizationCsp(assetBase: string | null): string {
  const own = assetBase ? ` ${assetBase}` : "";
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' https:${own}`,
    `style-src 'unsafe-inline' https:${own}`,
    `img-src data: blob: https:${own}`,
    `font-src data: https:${own}`,
    `media-src data: blob: https:${own}`,
    `connect-src https:${own}`,
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

/** Headers for a page, or for an asset beside it, which keeps the sandbox if it is navigated to. */
export function visualizationHeaders(contentType: string, assetBase: string | null) {
  return {
    "content-type": contentType,
    "content-security-policy": visualizationCsp(assetBase),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    // Replacing a visualization keeps its id, and pages from files show edits, so always ask again.
    "cache-control": "no-store",
  };
}

/** Types for the files a page loads beside it; anything else is a download, never sniffed. */
const ASSET_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".wasm": "application/wasm",
};

export function assetType(path: string): string {
  return ASSET_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Where a page shown from a file lives: its path under one of the thread's roots. */
export interface VisualizationSource {
  root: FileRoot;
  path: string;
}

function rootDir(roots: PreviewRoots, root: FileRoot): string {
  return root === "project" ? roots.project : roots.workspace;
}

/**
 * The root a file the agent named lies in, if any, so files beside it can be served. Files
 * elsewhere are still shown, but only as a copy, with nothing beside them.
 */
export async function findSource(roots: PreviewRoots, full: string): Promise<VisualizationSource | null> {
  const real = await realpath(full).catch(() => null);
  if (!real) return null;
  for (const root of ["project", "workspace"] as const) {
    const base = await realpath(rootDir(roots, root)).catch(() => null);
    if (!base || !real.startsWith(base + sep)) continue;
    const found = await resolveIn(base, relative(base, real));
    if (found?.kind === "file") return { root, path: found.path };
  }
  return null;
}

/**
 * Appended to every visualization so its card can fit it: it posts the height of the page's
 * content to the parent, which trusts nothing in the message but a clamped number from its own
 * frame. The content is measured rather than the document, which is never shorter than the frame,
 * so a small page lets its card shrink.
 */
export const HEIGHT_SCRIPT = `
<script>(() => {
  const post = () => {
    if (!document.body) return;
    const range = document.createRange();
    range.selectNodeContents(document.body);
    const style = getComputedStyle(document.body);
    const bottom = range.getBoundingClientRect().bottom + scrollY + parseFloat(style.paddingBottom) + parseFloat(style.marginBottom);
    parent.postMessage({ borkcodeHeight: Math.ceil(bottom) }, "*");
  };
  const observer = new ResizeObserver(post);
  observer.observe(document.documentElement);
  if (document.body) observer.observe(document.body);
  addEventListener("load", post);
})();</script>
`;

/**
 * HTML shown in a thread, kept as `visualizations/<id>.html` in the thread's attachments folder,
 * so it goes with the thread. The transcript item that shows it shares its id. A page shown from
 * a file in the thread's workspace or project files also has `<id>.json` naming that file: it is
 * served live from there, so edits show on reload (the copy stands in if the file goes away), and
 * the files in its folder are served beside it.
 */
export class VisualizationStore {
  readonly #attachments: AttachmentStore;

  constructor(attachments: AttachmentStore) {
    this.#attachments = attachments;
  }

  #path(threadId: string, id: string, extension = ".html"): string {
    return join(this.#attachments.dir(threadId), "visualizations", `${id}${extension}`);
  }

  /** Stores new HTML, or replaces the HTML of `id`, and returns its id. */
  async save(
    threadId: string,
    html: string,
    id: string = randomUUID(),
    source: VisualizationSource | null = null,
  ): Promise<string> {
    checkSize(Buffer.byteLength(html));
    const path = this.#path(threadId, id);
    await mkdir(join(path, ".."), { recursive: true });
    // Written aside and moved in, so a frame reloading meanwhile never sees half a page.
    await writeFile(`${path}.part`, html);
    await rename(`${path}.part`, path);
    const record = this.#path(threadId, id, ".json");
    if (source) await writeFile(record, JSON.stringify(source));
    else await rm(record, { force: true });
    return id;
  }

  async #source(threadId: string, id: string): Promise<VisualizationSource | null> {
    if (!isId(threadId) || !isId(id)) return null;
    const record = await readFile(this.#path(threadId, id, ".json"), "utf8").catch(() => null);
    return record ? (JSON.parse(record) as VisualizationSource) : null;
  }

  /**
   * The page as served, or null for anything that is not a visualization of this thread.
   * `hasAssets` says whether files beside it are served.
   */
  async page(threadId: string, id: string, roots: PreviewRoots): Promise<{ html: Buffer; hasAssets: boolean } | null> {
    if (!isId(threadId) || !isId(id)) return null;
    const copy = this.#path(threadId, id);
    if (!existsSync(copy)) return null;
    const source = await this.#source(threadId, id);
    const live = source ? await resolveIn(rootDir(roots, source.root), source.path) : null;
    const size = live?.kind === "file" ? (await stat(live.full)).size : 0;
    const html = size > 0 && size <= MAX_VISUALIZATION_BYTES ? await readFile(live!.full) : await readFile(copy);
    return { html: Buffer.concat([html, Buffer.from(HEIGHT_SCRIPT)]), hasAssets: source !== null };
  }

  /**
   * A file in the folder of a page shown from a file, or below it, or null. Hidden files and
   * folders (`.env`, `.git`) are never served, and `..` and symlinks cannot leave the page's root.
   */
  async asset(threadId: string, id: string, path: string, roots: PreviewRoots): Promise<string | null> {
    const source = await this.#source(threadId, id);
    if (!source || !existsSync(this.#path(threadId, id))) return null;
    const segments = path.split(/[\\/]+/).filter(Boolean);
    if (segments.length === 0 || segments.some((segment) => segment.startsWith("."))) return null;
    const folder = source.path.split("/").slice(0, -1);
    const found = await resolveIn(rootDir(roots, source.root), [...folder, ...segments].join("/"));
    return found?.kind === "file" ? found.full : null;
  }
}

/** Reads an HTML file the agent wrote, refusing it when it is too large to show. */
export async function readHtmlFile(path: string): Promise<string> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new ToolError(`There is no file at ${path}.`);
  checkSize(info.size);
  return readFile(path, "utf8");
}

function checkSize(bytes: number): void {
  if (bytes === 0) throw new ToolError("The HTML is empty.");
  if (bytes > MAX_VISUALIZATION_BYTES) {
    throw new ToolError(
      `The HTML is ${(bytes / 1024 / 1024).toFixed(1)} MB; visualizations can be at most ${MAX_VISUALIZATION_BYTES / 1024 / 1024} MB. Load large libraries from a CDN instead of inlining them.`,
    );
  }
}
