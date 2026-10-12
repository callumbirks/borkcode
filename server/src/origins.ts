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
