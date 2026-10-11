import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Config {
  /** Root of all borkcode data: state.sqlite and projects/. */
  home: string;
  port: number;
  host: string;
  /** Built web client to serve, if present. */
  webDist: string;
}

export function loadConfig(): Config {
  return {
    home: resolve(process.env.BORKCODE_HOME ?? join(homedir(), "borkcode")),
    port: Number(process.env.PORT ?? 4800),
    host: process.env.HOST ?? "127.0.0.1",
    webDist: resolve(import.meta.dirname, "../../web/dist"),
  };
}
