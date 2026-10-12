import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AttachmentStore } from "./attachments.ts";
import { isAllowedOrigin, isSameSiteFetch } from "./origins.ts";
import { VISUALIZATION_CSP, VISUALIZATION_HEADERS, VisualizationStore } from "./visualizations.ts";

const home = await mkdtemp(join(tmpdir(), "borkcode-visualizations-"));
after(() => rm(home, { recursive: true, force: true }));
const store = new VisualizationStore(new AttachmentStore(home));
const threadId = randomUUID();

test("pages are served with a height reporter only to their own thread, and only by UUID", async () => {
  const id = await store.save(threadId, "<h1>hi</h1>");
  const page = String(await store.page(threadId, id));
  assert.match(page, /^<h1>hi<\/h1>\n<script>.*borkcodeHeight.*<\/script>\n$/s);
  assert.equal(await store.page(randomUUID(), id), null);
  assert.equal(await store.page(threadId, randomUUID()), null);
  for (const bad of ["..", `../${id}`, `${id}.html`, ""]) assert.equal(await store.page(threadId, bad), null);
  assert.equal(await store.page("..", id), null);
});

test("pages run sandboxed in an opaque origin, with https: resources only", () => {
  const directives = VISUALIZATION_CSP.split("; ");
  assert.ok(directives.includes("sandbox allow-scripts"));
  assert.ok(!VISUALIZATION_CSP.includes("allow-same-origin"));
  assert.ok(!VISUALIZATION_CSP.includes("allow-top-navigation"));
  assert.ok(!VISUALIZATION_CSP.includes("allow-popups"));
  assert.ok(!VISUALIZATION_CSP.includes("allow-forms"));
  assert.ok(directives.includes("default-src 'none'"));
  // Nothing may load from borkcode itself or plain http: (localhost); only borkcode may frame it.
  for (const directive of directives.filter((directive) => !directive.startsWith("frame-ancestors"))) {
    assert.doesNotMatch(directive, /\bhttp:|\bws:|'self'/, directive);
  }
  assert.ok(directives.includes("frame-ancestors 'self'"));
  assert.equal(VISUALIZATION_HEADERS["x-content-type-options"], "nosniff");
  assert.equal(VISUALIZATION_HEADERS["content-type"], "text/html; charset=utf-8");
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
