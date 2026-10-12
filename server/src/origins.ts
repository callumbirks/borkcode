import type { IncomingMessage } from "node:http";
import { isLoopback, isTailscaleAddress } from "./config.ts";

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

/** Strict authority parsing: URL's permissive userinfo/path handling is inappropriate for Host. */
export function hostName(host: string | undefined): string | null {
  if (!host || !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::[0-9]+)?$/i.test(host)) return null;
  try { return new URL(`http://${host}`).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch { return null; }
}

export interface AccessPolicy {
  host: string;
  remoteHosts: readonly string[];
}

export function isAllowedHost(request: IncomingMessage, policy: AccessPolicy): boolean {
  const name = hostName(request.headers.host);
  return name !== null && (name === "localhost" || name === "127.0.0.1" || name === "::1" ||
    name === policy.host || policy.remoteHosts.includes(name));
}

/** Serve preserves Host; never accept forwarded Host as authority. Funnel isn't the access boundary. */
export function isAllowedRequest(request: IncomingMessage, policy: AccessPolicy): boolean {
  const peer = request.socket.remoteAddress;
  if (!isLoopback(peer) && (!peer || !isTailscaleAddress(peer))) return false;
  if (!isAllowedHost(request, policy)) return false;
  const asset = isAssetRequest(request);
  if (!asset && !isAllowedOrigin(request)) return false;
  // A user may open the app from a link on another site. Sandboxed frames cannot navigate the
  // top-level page, and subresources never carry both document destination and user activation.
  const openApp = request.method === "GET" && !request.url?.startsWith("/api/") &&
    !request.url?.startsWith("/mcp/") && request.headers["sec-fetch-mode"] === "navigate" &&
    request.headers["sec-fetch-dest"] === "document" && request.headers["sec-fetch-user"] === "?1";
  if (!asset && !isSameSiteFetch(request) && !openApp) return false;
  if (request.headers["tailscale-funnel-request"] !== undefined) return false;
  const forwarded = Object.keys(request.headers).some((key) => key.startsWith("x-forwarded-") || key.startsWith("tailscale-") || key === "forwarded");
  // Proxy traffic must arrive from loopback and name an allowed tailnet host.
  if (forwarded && (!isLoopback(request.socket.remoteAddress) || !policy.remoteHosts.includes(hostName(request.headers.host) ?? ""))) return false;
  return true;
}

/** Agents use a direct local socket. A loopback peer alone also includes remote Serve traffic. */
export function isLocalMcpRequest(request: IncomingMessage): boolean {
  const name = hostName(request.headers.host);
  return isLoopback(request.socket.remoteAddress) && name !== null && isLoopback(name) &&
    request.headers.origin === undefined && request.headers["sec-fetch-site"] === undefined &&
    !Object.keys(request.headers).some((key) => key.startsWith("x-forwarded-") || key.startsWith("tailscale-") || key === "forwarded");
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
 * add to the policy. Only a loopback proxy for an allowlisted remote host can supply the
 * forwarded HTTPS scheme; a direct tailnet client cannot choose it with spoofed headers.
 */
export function assetBase(
  request: IncomingMessage,
  threadId: string,
  visualizationId: string,
  policy: AccessPolicy = { host: "127.0.0.1", remoteHosts: [] },
): string | null {
  const host = request.headers.host;
  const name = hostName(host);
  if (!name) return null;
  const proxiedHttps = isLoopback(request.socket?.remoteAddress) && policy.remoteHosts.includes(name) &&
    request.headers["x-forwarded-proto"] === "https" && request.headers["x-forwarded-host"] === host;
  const scheme = proxiedHttps ? "https" : "http";
  return `${scheme}://${host}/api/threads/${threadId}/visualizations/${visualizationId}/`;
}
