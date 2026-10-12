import type { IncomingMessage } from "node:http";

/**
 * Browsers let any page open a WebSocket to localhost, so only same-origin pages may connect.
 * Sandboxed documents, such as visualizations, send `Origin: null`, which is refused.
 */
export function isAllowedOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

/**
 * Requests that carry no Origin, such as an image loaded by a page, still say where they come from
 * in `sec-fetch-site`. Missing means a client other than a browser.
 */
export function isSameSiteFetch(request: IncomingMessage): boolean {
  const site = request.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

/**
 * Requests a visualization makes for the files beside it, at
 * `/api/threads/<id>/visualizations/<id>/<path>`. They come from its sandboxed, opaque origin, so
 * they carry `Origin: null` (fetches, fonts) or none and `sec-fetch-site: cross-site` (images,
 * scripts, styles), which every other route refuses. This route alone accepts them, for GET: the
 * unguessable thread and visualization ids in its URL are the capability, and it serves only the
 * files under that page's folder. Other sites' pages are still refused when they say who they are.
 * A request gate in front of all routes should let these through with this same check.
 */
export function isAssetRequest(request: IncomingMessage): boolean {
  const path = new URL(request.url ?? "/", "http://x").pathname;
  return (
    request.method === "GET" &&
    /^\/api\/threads\/[\w-]+\/visualizations\/[\w-]+\/.+$/.test(path) &&
    (request.headers.origin === "null" || isAllowedOrigin(request))
  );
}

/**
 * The URL prefix a page's assets are served under, as a CSP source. It names this server as the
 * browser reached it; a Host header that is not a plain host and port gives none, so it cannot
 * add to the policy. An `http:` source also matches `https:`, so it works behind HTTPS too.
 */
export function assetBase(request: IncomingMessage, threadId: string, visualizationId: string): string | null {
  const host = request.headers.host ?? "";
  if (!/^([\w.-]+|\[[0-9a-fA-F:.]+\])(:\d+)?$/.test(host)) return null;
  return `http://${host}/api/threads/${threadId}/visualizations/${visualizationId}/`;
}
