import { isIP } from "node:net";
import { networkInterfaces, platform, type NetworkInterfaceInfo } from "node:os";
import type { NetworkState } from "shared/protocol";
import { isTailscaleAddress } from "./config.ts";
import { run } from "./exec.ts";
import { hostName, type AccessPolicy } from "./origins.ts";

export { isTailscaleAddress } from "./config.ts";

export interface Tailnet {
  addresses: string[];
  dnsName: string | null;
  httpsUrl: string | null;
}

interface TailscaleStatus {
  BackendState?: string;
  Self?: { DNSName?: string; TailscaleIPs?: string[] };
}

/** CGNAT ranges alone do not prove an interface belongs to Tailscale. */
export function tailscaleAddresses(interfaces: Record<string, NetworkInterfaceInfo[] | undefined>,
  os: string, status: TailscaleStatus | null): string[] {
  if (status !== null) return status.BackendState === "Running"
    ? [...new Set((status.Self?.TailscaleIPs ?? []).filter((ip) => typeof ip === "string" && isTailscaleAddress(ip)))] : [];
  return [...new Set(Object.entries(interfaces).flatMap(([name, entries]) => {
    const known = os === "linux" ? name === "tailscale0" : os === "darwin" && /^utun\d+$/.test(name);
    return known ? (entries ?? []).filter((entry) => !entry.internal && isTailscaleAddress(entry.address)).map((entry) => entry.address) : [];
  }))];
}

/** Read only after opt-in: some Tailscale builds prompt when another app runs their CLI. */
export async function detectTailnet(port: number): Promise<Tailnet> {
  let status: TailscaleStatus | null = null;
  try {
    status = JSON.parse(await run("tailscale", ["status", "--json"], { timeoutMs: 2000 })) as TailscaleStatus;
  } catch { /* Without the CLI, inspect only known Tailscale interfaces. */ }
  const addresses = tailscaleAddresses(networkInterfaces(), platform(), status);
  let dnsName: string | null = null;
  let httpsUrl: string | null = null;
  if (status?.BackendState === "Running") {
    const name = String(status.Self?.DNSName ?? "").toLowerCase().replace(/\.$/, "");
    if (/^[a-z0-9-]+\.[a-z0-9.-]+\.ts\.net$/.test(name)) dnsName = name;
  }
  if (dnsName) {
    try {
      const serve = JSON.parse(await run("tailscale", ["serve", "status", "--json"], { timeoutMs: 2000 })) as ServeConfig;
      httpsUrl = serveEndpoint(serve, dnsName, port);
    } catch { /* Serve is optional; its failure must not change the discovered addresses. */ }
  }
  return { addresses, dnsName, httpsUrl };
}

interface ServeConfig {
  TCP?: Record<string, { HTTPS?: boolean }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

export function serveEndpoint(serve: ServeConfig, dnsName: string, port: number): string | null {
  for (const [authority, site] of Object.entries(serve.Web ?? {})) {
    try {
      const url = new URL(`https://${authority}`);
      const target = site.Handlers?.["/"]?.Proxy;
      if (url.hostname !== dnsName || !target || !serve.TCP?.[url.port || "443"]?.HTTPS) continue;
      const backend = new URL(/^\d+$/.test(target) ? `http://127.0.0.1:${target}` : target);
      if (backend.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(backend.hostname) &&
        Number(backend.port) === port && backend.pathname === "/") return url.origin + "/";
    } catch { /* Another Serve site may still match. */ }
  }
  return null;
}

async function probeHttps(url: string, port: number): Promise<boolean> {
  try {
    const response = await fetch(new URL("api/network-check", url), { signal: AbortSignal.timeout(2000), redirect: "error" });
    const info = await response.json() as { application?: string; port?: number };
    return response.ok && info.application === "borkcode" && info.port === port;
  } catch { return false; }
}

/** Owns only the tailnet listeners. The main loopback listener is never closed by this service. */
export class NetworkAccess {
  readonly policy: AccessPolicy;
  state: NetworkState;
  #listeners = new Map<string, () => Promise<void>>();
  #queue: Promise<void> = Promise.resolve();
  readonly #port: number;
  readonly #listen: (address: string) => Promise<() => Promise<void>>;
  readonly #changed: (state: NetworkState) => void;
  readonly #detect: (port: number) => Promise<Tailnet>;
  readonly #probe: (url: string, port: number) => Promise<boolean>;

  constructor(port: number, host: string, listen: (address: string) => Promise<() => Promise<void>>,
    changed: (state: NetworkState) => void, detect = detectTailnet, probe = probeHttps) {
    this.#port = port;
    this.policy = { host, remoteHosts: [] };
    this.#listen = listen;
    this.#changed = changed;
    this.#detect = detect;
    this.#probe = probe;
    this.state = { enabled: false, endpoints: [{ label: "This machine", url: `http://${host === "::1" ? "[::1]" : host}:${port}/` }], message: null };
  }

  refresh(enabled: boolean): Promise<void> {
    const next = this.#queue.then(() => this.#refresh(enabled));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #refresh(enabled: boolean): Promise<void> {
    const found = enabled ? await this.#detect(this.#port) : { addresses: [], dnsName: null, httpsUrl: null };
    // Revalidate injected discovery too: no listener can accidentally bind a LAN or wildcard IP.
    const addresses = found.addresses.filter(isTailscaleAddress);
    this.policy.remoteHosts = enabled ? [...addresses.map((address) => hostName(isIP(address) === 6 ? `[${address}]` : address)!), ...(found.dnsName ? [found.dnsName] : [])] : [];
    for (const [address, close] of this.#listeners) {
      if (addresses.includes(address)) continue;
      await close();
      this.#listeners.delete(address);
    }
    const failures: string[] = [];
    for (const address of addresses) {
      if (this.#listeners.has(address)) continue;
      try { this.#listeners.set(address, await this.#listen(address)); }
      catch { failures.push(address); }
    }
    const endpoints = [this.state.endpoints[0]!];
    for (const address of this.#listeners.keys()) {
      endpoints.push({ label: "Tailscale IP", url: `http://${isIP(address) === 6 ? `[${address}]` : address}:${this.#port}/` });
    }
    if (found.dnsName && this.#listeners.size) endpoints.push({ label: "Tailscale MagicDNS", url: `http://${found.dnsName}:${this.#port}/` });
    if (found.httpsUrl && await this.#probe(found.httpsUrl, this.#port)) endpoints.push({ label: "Tailscale HTTPS (Serve)", url: found.httpsUrl });
    const message = !enabled ? null : endpoints.length === 1 ? "Tailscale isn't available yet. Connect it; borkcode checks again every 30 seconds." :
      failures.length ? "Some Tailscale addresses could not be opened; use one of the URLs below." : null;
    const next = { enabled, endpoints, message };
    if (JSON.stringify(next) !== JSON.stringify(this.state)) { this.state = next; this.#changed(next); }
  }
}
