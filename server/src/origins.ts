import type { IncomingMessage } from "node:http";
import { isLoopback, type Config } from "./config.ts";

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
  try { return new URL(`http://${host}`).hostname.toLowerCase(); } catch { return null; }
}

export function isAllowedHost(request: IncomingMessage, config: Pick<Config, "host" | "tailnetHost">): boolean {
  const name = hostName(request.headers.host);
  return name !== null && (name === "localhost" || name === "127.0.0.1" || name === "[::1]" ||
    name === config.tailnetHost || (config.host !== "0.0.0.0" && config.host !== "::" && name === config.host));
}

/** Serve preserves Host; never accept forwarded Host as authority. Funnel isn't the access boundary. */
export function isAllowedRequest(request: IncomingMessage, config: Config): boolean {
  if (!isAllowedHost(request, config) || !isAllowedOrigin(request) || !isSameSiteFetch(request)) return false;
  if (request.headers["tailscale-funnel-request"] !== undefined) return false;
  if (hostName(request.headers.host) === config.tailnetHost && config.tailnetLogin) {
    return isLoopback(request.socket.remoteAddress) && request.headers["tailscale-user-login"] === config.tailnetLogin;
  }
  return true;
}

/** Agents use a direct local socket. A loopback peer alone also includes remote Serve traffic. */
export function isLocalMcpRequest(request: IncomingMessage): boolean {
  const name = hostName(request.headers.host);
  return isLoopback(request.socket.remoteAddress) && name !== null && isLoopback(name) &&
    request.headers.origin === undefined &&
    !Object.keys(request.headers).some((key) => key.startsWith("x-forwarded-") || key.startsWith("tailscale-") || key === "forwarded");
}
