import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isId, type AttachmentStore } from "./attachments.ts";
import { ToolError } from "./errors.ts";

export const MAX_VISUALIZATION_BYTES = 2 * 1024 * 1024;

/**
 * Visualizations are agent-written HTML with scripts, so they run sandboxed in an opaque origin:
 * they cannot read borkcode's pages, and their requests to `/api` and `/ws` carry `Origin: null`,
 * which is refused. Scripts, styles, images, fonts and fetches may come from any `https:` host,
 * since agents load chart libraries from CDNs; plain `http:` stays closed. HTTPS borkcode requests are refused globally by Origin and
 * Sec-Fetch-Site, including script/image requests that carry no Origin. Tighten here, for example to a list of CDN hosts.
 */
export const VISUALIZATION_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "font-src data: https:",
  "media-src data: blob: https:",
  "connect-src https:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

export const VISUALIZATION_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": VISUALIZATION_CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  // Replacing a visualization keeps its id, so always ask again.
  "cache-control": "no-store",
};

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
 * so it goes with the thread. The transcript item that shows it shares its id.
 */
export class VisualizationStore {
  readonly #attachments: AttachmentStore;

  constructor(attachments: AttachmentStore) {
    this.#attachments = attachments;
  }

  #path(threadId: string, id: string): string {
    return join(this.#attachments.dir(threadId), "visualizations", `${id}.html`);
  }

  /** Stores new HTML, or replaces the HTML of `id`, and returns its id. */
  async save(threadId: string, html: string, id: string = randomUUID()): Promise<string> {
    checkSize(Buffer.byteLength(html));
    const path = this.#path(threadId, id);
    await mkdir(join(path, ".."), { recursive: true });
    // Written aside and moved in, so a frame reloading meanwhile never sees half a page.
    await writeFile(`${path}.part`, html);
    await rename(`${path}.part`, path);
    return id;
  }

  /** The page as served, or null for anything that is not a visualization of this thread. */
  async page(threadId: string, id: string): Promise<Buffer | null> {
    if (!isId(threadId) || !isId(id)) return null;
    const path = this.#path(threadId, id);
    if (!existsSync(path)) return null;
    return Buffer.concat([await readFile(path), Buffer.from(HEIGHT_SCRIPT)]);
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
