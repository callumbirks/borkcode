import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AttachmentStore } from "./attachments.ts";
import { assetBase, isAllowedOrigin, isAssetRequest, isSameSiteFetch } from "./origins.ts";
import type { PreviewRoots } from "./threadFiles.ts";
import { assetType, findSource, visualizationCsp, visualizationHeaders, VisualizationStore } from "./visualizations.ts";

const home = await mkdtemp(join(tmpdir(), "borkcode-visualizations-"));
after(() => rm(home, { recursive: true, force: true }));
const store = new VisualizationStore(new AttachmentStore(home));
const threadId = randomUUID();
const roots: PreviewRoots = { workspace: join(home, "workspace"), project: join(home, "files"), repos: [] };

async function put(path: string, content = "x") {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

const mockup = join(roots.project, "mockups", "admin");
await put(join(mockup, "index.html"), "<h1>live</h1>");
await put(join(mockup, "assets", "font.woff2"), "font");
await put(join(mockup, "assets", "sprite.png"), "png");
await put(join(mockup, "data.json"), "{}");
await put(join(mockup, ".env"), "SECRET=1");
await put(join(mockup, "assets", ".git", "config"), "git");
await put(join(roots.project, "mockups", "other.txt"), "sibling folder");
await put(join(roots.workspace, "repo", "README.md"), "workspace");
await put(join(home, "outside.txt"), "outside");
await symlink(join(home, "outside.txt"), join(mockup, "leak.txt"));
await symlink(join(roots.workspace, "repo"), join(mockup, "workspace-link"));

test("pages are served with a height reporter only to their own thread, and only by UUID", async () => {
  const id = await store.save(threadId, "<h1>hi</h1>");
  const page = await store.page(threadId, id, roots);
  assert.match(String(page?.html), /^<h1>hi<\/h1>\n<script>.*borkcodeHeight.*<\/script>\n$/s);
  assert.equal(page?.hasAssets, false);
  assert.equal(await store.page(randomUUID(), id, roots), null);
  assert.equal(await store.page(threadId, randomUUID(), roots), null);
  for (const bad of ["..", `../${id}`, `${id}.html`, ""]) assert.equal(await store.page(threadId, bad, roots), null);
  assert.equal(await store.page("..", id, roots), null);
});

test("a page from a file is served live and loads the files in its folder by relative path", async () => {
  const source = await findSource(roots, join(mockup, "index.html"));
  assert.deepEqual(source, { root: "project", path: "mockups/admin/index.html" });
  const id = await store.save(threadId, "<h1>copy</h1>", undefined, source);
  const page = await store.page(threadId, id, roots);
  assert.match(String(page?.html), /^<h1>live<\/h1>/);
  assert.equal(page?.hasAssets, true);

  assert.equal(await store.asset(threadId, id, "assets/font.woff2", roots), join(mockup, "assets", "font.woff2"));
  assert.equal(await store.asset(threadId, id, "data.json", roots), join(mockup, "data.json"));
  assert.equal(await store.asset(threadId, id, "index.html", roots), join(mockup, "index.html"));
  for (const refused of [
    "../other.txt",
    "assets/../../other.txt",
    "..\\other.txt",
    ".env",
    "assets/.git/config",
    "leak.txt",
    "workspace-link/README.md",
    "assets",
    "missing.png",
    "",
  ]) {
    assert.equal(await store.asset(threadId, id, refused, roots), null, refused);
  }
  // Only this thread's visualization, under its own id.
  assert.equal(await store.asset(randomUUID(), id, "data.json", roots), null);
  assert.equal(await store.asset(threadId, randomUUID(), "data.json", roots), null);

  // With the file gone, the copy stands in.
  await rm(join(mockup, "index.html"));
  assert.match(String((await store.page(threadId, id, roots))?.html), /^<h1>copy<\/h1>/);
  await put(join(mockup, "index.html"), "<h1>live</h1>");

  // Replaced with inline HTML, it loses its folder.
  await store.save(threadId, "<p>inline</p>", id);
  assert.equal(await store.asset(threadId, id, "data.json", roots), null);
  assert.equal((await store.page(threadId, id, roots))?.hasAssets, false);
});

test("inline pages and files outside the thread's roots get no assets", async () => {
  const inline = await store.save(threadId, "<p>inline</p>");
  assert.equal(await store.asset(threadId, inline, "data.json", roots), null);
  assert.equal(await findSource(roots, join(home, "outside.txt")), null);
  assert.equal(await findSource(roots, join(mockup, "leak.txt")), null);
  assert.equal(await findSource(roots, join(mockup, "assets", ".git", "config")), null);
  assert.deepEqual(await findSource(roots, join(roots.workspace, "repo", "README.md")), {
    root: "workspace",
    path: "repo/README.md",
  });
});

test("assets get their web content types, and anything else is a download", () => {
  assert.equal(assetType("a/font.WOFF2"), "font/woff2");
  assert.equal(assetType("x.ttf"), "font/ttf");
  assert.equal(assetType("x.png"), "image/png");
  assert.equal(assetType("x.css"), "text/css; charset=utf-8");
  assert.equal(assetType("x.js"), "text/javascript; charset=utf-8");
  assert.equal(assetType("x.json"), "application/json");
  assert.equal(assetType("x.wasm"), "application/wasm");
  assert.equal(assetType("x.mp3"), "audio/mpeg");
  assert.equal(assetType("x.svg"), "image/svg+xml");
  assert.equal(assetType("Makefile"), "application/octet-stream");
  assert.equal(assetType("x.sh"), "application/octet-stream");
});

test("pages and assets run sandboxed in an opaque origin, with https: and their own assets only", () => {
  const base = "http://localhost:4000/api/threads/t/visualizations/v/";
  for (const csp of [visualizationCsp(null), visualizationCsp(base)]) {
    const directives = csp.split("; ");
    assert.ok(directives.includes("sandbox allow-scripts"));
    for (const flag of ["allow-same-origin", "allow-top-navigation", "allow-popups", "allow-forms"]) {
      assert.ok(!csp.includes(flag), flag);
    }
    assert.ok(directives.includes("default-src 'none'"));
    // Nothing may load from borkcode itself, beyond the page's own assets, or from plain http: or ws:.
    for (const directive of directives.filter((directive) => !directive.startsWith("frame-ancestors"))) {
      assert.doesNotMatch(directive.replace(base, ""), /\bhttp:|\bws:|'self'/, directive);
    }
    assert.ok(directives.includes("frame-ancestors 'self'"));
  }
  assert.ok(visualizationCsp(base).includes(`font-src data: https: ${base}`));
  assert.ok(visualizationCsp(base).includes(`connect-src https: ${base}`));
  const headers = visualizationHeaders("image/svg+xml", base);
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.match(headers["content-security-policy"], /^sandbox allow-scripts;/);
});

function request(headers: Record<string, string>): IncomingMessage {
  return { headers: { host: "localhost:4000", ...headers } } as unknown as IncomingMessage;
}

test("requests from a sandboxed page are refused by the API and the WebSocket", () => {
  // fetch, XHR and WebSocket from an opaque origin say `Origin: null`.
  assert.equal(isAllowedOrigin(request({ origin: "null" })), false);
  // Subresource loads and navigations from it carry no Origin, but are cross-site.
  assert.equal(isSameSiteFetch(request({ "sec-fetch-site": "cross-site" })), false);
  assert.equal(isAllowedOrigin(request({ origin: "http://evil.test" })), false);
  assert.equal(isAllowedOrigin(request({ origin: "http://localhost:4000" })), true);
  assert.equal(isSameSiteFetch(request({ "sec-fetch-site": "same-origin" })), true);
});

test("only the asset route takes requests from the sandboxed page, and never from other sites", () => {
  const asset = "/api/threads/t/visualizations/v/assets/font.woff2";
  const from = (url: string, headers: Record<string, string>, method = "GET") =>
    ({ ...request(headers), url, method }) as IncomingMessage;
  assert.equal(isAssetRequest(from(asset, { origin: "null", "sec-fetch-site": "cross-site" })), true);
  assert.equal(isAssetRequest(from(asset, { "sec-fetch-site": "cross-site" })), true);
  assert.equal(isAssetRequest(from(`${asset}?x=1`, { origin: "http://localhost:4000" })), true);
  assert.equal(isAssetRequest(from(asset, { origin: "https://evil.test", "sec-fetch-site": "cross-site" })), false);
  assert.equal(isAssetRequest(from(asset, { origin: "null" }, "POST")), false);
  // The page itself, and every other route, still refuse the sandbox.
  for (const url of [
    "/api/threads/t/visualizations/v/",
    "/api/threads/t/visualizations/v",
    "/api/threads/t/files?root=workspace&path=",
    "/api/threads/t/attachments/a",
    "/ws",
    "/mcp/token",
    "/api/threads/t/visualizations/v/../../files",
  ]) {
    assert.equal(isAssetRequest(from(url, { origin: "null", "sec-fetch-site": "cross-site" })), false, url);
  }
});

test("the asset base names this server, and a strange Host adds nothing to the policy", () => {
  assert.equal(assetBase(request({}), "t", "v"), "http://localhost:4000/api/threads/t/visualizations/v/");
  assert.equal(assetBase(request({ host: "[::1]:4000" }), "t", "v"), "http://[::1]:4000/api/threads/t/visualizations/v/");
  for (const host of ["a; script-src *", "a b", "", "a/b"]) assert.equal(assetBase(request({ host }), "t", "v"), null, host);
});
