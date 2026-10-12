import { homedir } from "node:os";
import { isIP } from "node:net";
import { join, resolve } from "node:path";

export interface Config {
  /** Root of all borkcode data: state.sqlite and projects/. */
  home: string;
  port: number;
  host: string;
  /** Built web client to serve, if present. */
  webDist: string;
}

export function isLoopback(address: string | undefined): boolean {
  return address === "localhost" || address === "::1" || address === "[::1]" ||
    (!!address && /^127\.\d+\.\d+\.\d+$/.test(address) && isIP(address) === 4) ||
    (!!address && address.startsWith("::ffff:") && isLoopback(address.slice(7)));
}

export function isTailscaleAddress(address: string): boolean {
  if (address.toLowerCase().startsWith("::ffff:")) return isTailscaleAddress(address.slice(7));
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 100 && b! >= 64 && b! <= 127;
  }
  return isIP(address) === 6 && address.toLowerCase().startsWith("fd7a:115c:a1e0:");
}


export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.HOST ?? "127.0.0.1";
  if (!isLoopback(host)) throw new Error("HOST must be loopback; turn on Network access in Settings for Tailscale");
  return {
    home: resolve(env.BORKCODE_HOME ?? join(homedir(), "borkcode")),
    port: Number(env.PORT ?? 4800),
    host,
    webDist: resolve(import.meta.dirname, "../../web/dist"),
  };
}
