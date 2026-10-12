import { homedir } from "node:os";
import { isIP } from "node:net";
import { join, resolve } from "node:path";

export interface Config {
  /** Root of all borkcode data: state.sqlite and projects/. */
  home: string;
  port: number;
  host: string;
  tailnetHost: string | null;
  tailnetLogin: string | null;
  /** Built web client to serve, if present. */
  webDist: string;
}

export function isLoopback(address: string | undefined): boolean {
  return address === "localhost" || address === "::1" || address === "[::1]" ||
    (!!address && /^127\.\d+\.\d+\.\d+$/.test(address) && isIP(address) === 4) ||
    (!!address && address.startsWith("::ffff:") && isLoopback(address.slice(7)));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.HOST ?? "127.0.0.1";
  if (!isLoopback(host) && env.BORKCODE_ALLOW_NETWORK_BIND !== "true") {
    throw new Error("Use tailscale serve with localhost, or explicitly set BORKCODE_ALLOW_NETWORK_BIND=true to expose HOST");
  }
  const tailnetHost = env.BORKCODE_TAILNET_HOST?.toLowerCase() || null;
  if (tailnetHost && !/^[a-z0-9-]+\.[a-z0-9.-]+\.ts\.net$/.test(tailnetHost)) {
    throw new Error("BORKCODE_TAILNET_HOST must be the full machine.tailnet.ts.net hostname (without scheme or port)");
  }
  const tailnetLogin = env.BORKCODE_TAILNET_LOGIN || null;
  if (tailnetLogin && (!tailnetHost || !isLoopback(host))) {
    throw new Error("BORKCODE_TAILNET_LOGIN requires BORKCODE_TAILNET_HOST and a loopback listener");
  }
  return {
    home: resolve(env.BORKCODE_HOME ?? join(homedir(), "borkcode")),
    port: Number(env.PORT ?? 4800),
    host,
    tailnetHost,
    tailnetLogin,
    webDist: resolve(import.meta.dirname, "../../web/dist"),
  };
}
