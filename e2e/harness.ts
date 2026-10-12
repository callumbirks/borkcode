// Starts the built server on a temp home with seeded threads, and launches browsers against it.
// No provider is ever called: Codex is `fake-codex.mjs`, and Claude, gh and tailscale fail at once.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { chromium, devices, webkit, type Browser, type BrowserContextOptions, type Page, type WebSocketRoute } from "playwright";
import type { Item, StoredThreadSeed } from "./seed.ts";
import { seed } from "./seed.ts";

const repo = resolve(import.meta.dirname, "..");

export type Server = { url: string; port: number; home: string; stop: () => Promise<void> };

/**
 * `settings` is written as settings.json. `tailnet` names a MagicDNS host the fake Tailscale CLI
 * reports, with network access on, so a browser that resolves it to loopback reaches the server as
 * a tailnet device would, over plain HTTP. Its Tailscale address is not on this machine, so only
 * that name is usable.
 */
export async function startServer(
  threads: StoredThreadSeed[],
  visualizations: Record<string, Record<string, string>> = {},
  settings?: Record<string, unknown>,
  { tailnet }: { tailnet?: string } = {},
): Promise<Server> {
  const home = await mkdtemp(join(tmpdir(), "borkcode-e2e-"));
  const bin = join(home, "bin");
  await mkdir(bin);
  for (const name of ["gh", "tailscale", "claude"]) {
    await writeFile(join(bin, name), "#!/bin/sh\nexit 1\n");
    await chmod(join(bin, name), 0o755);
  }
  if (tailnet) {
    const status = { BackendState: "Running", Self: { DNSName: `${tailnet}.`, TailscaleIPs: ["100.100.100.100"] } };
    await writeFile(join(bin, "tailscale"), `#!/bin/sh\n[ "$1" = status ] && echo '${JSON.stringify(status)}' && exit 0\nexit 1\n`);
    settings = { ...settings, networkAccess: true };
  }
  await seed(home, threads, visualizations, tallPng(400, 900));
  if (settings) await writeFile(join(home, "settings.json"), JSON.stringify(settings));

  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as { port: number }).port;
  await new Promise((done) => probe.close(done));

  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/src/main.ts"], {
    cwd: repo,
    env: {
      ...process.env,
      BORKCODE_HOME: home,
      PORT: String(port),
      HOST: "127.0.0.1",
      BORKCODE_CODEX_BIN: join(import.meta.dirname, "fake-codex.mjs"),
      BORKCODE_CLAUDE_BIN: join(bin, "claude"),
      PATH: `${bin}:${process.env.PATH}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stderr.on("data", (data) => (logs += data));
  await new Promise<void>((done, fail) => {
    child.stdout.on("data", (data) => {
      logs += data;
      if (logs.includes("listening on")) done();
    });
    child.once("exit", () => fail(new Error(`server exited:\n${logs}`)));
  });
  // Network access is detected after the server starts listening; wait until it admits the name.
  while (tailnet) {
    const allowed = await new Promise<boolean>((done) =>
      request({ host: "127.0.0.1", port, path: "/api/network-check", headers: { host: `${tailnet}:${port}` } }, (response) => {
        response.resume();
        done(response.statusCode === 200);
      }).end(),
    );
    if (allowed) break;
  }
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    home,
    async stop() {
      if (child.exitCode === null) {
        child.kill();
        await once(child, "exit");
      }
      await rm(home, { recursive: true, force: true });
    },
  };
}

/** A solid PNG, for an image whose height arrives only when it loads. */
function tallPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x55)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}

export type Engine = "chromium" | "webkit";

/**
 * Playwright's WebKit is built for Ubuntu. Elsewhere (e.g. Fedora) it needs Ubuntu 24.04's
 * libicu74 and libjpeg-turbo8 libraries in a folder of their own, by default
 * ~/.cache/borkcode/e2e-webkit-libs or else BORKCODE_E2E_WEBKIT_LIBS (see the README).
 * MiniBrowser is then started with them on its library path.
 */
export const WEBKIT_LIBS_DEFAULT = join(homedir(), ".cache", "borkcode", "e2e-webkit-libs");

function webkitLibs(): string | undefined {
  if (process.env.BORKCODE_E2E_WEBKIT_LIBS) return resolve(process.env.BORKCODE_E2E_WEBKIT_LIBS);
  return existsSync(WEBKIT_LIBS_DEFAULT) ? WEBKIT_LIBS_DEFAULT : undefined;
}

async function webkitExecutable(): Promise<string | undefined> {
  const extra = webkitLibs();
  if (!extra) return undefined;
  process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "1";
  const bundle = join(resolve(webkit.executablePath(), ".."), "minibrowser-wpe");
  const wrapper = join(await mkdtemp(join(tmpdir(), "borkcode-webkit-")), "MiniBrowser");
  await writeFile(
    wrapper,
    `#!/bin/sh
export WEBKIT_EXEC_PATH="${bundle}/bin"
export WEBKIT_INJECTED_BUNDLE_PATH="${bundle}/lib"
export WEBKIT_INSPECTOR_RESOURCES_PATH="${bundle}/share"
export LD_LIBRARY_PATH="${bundle}/lib:${bundle}/sys/lib:${extra}"
exec "${bundle}/bin/MiniBrowser" "$@"
`,
  );
  await chmod(wrapper, 0o755);
  return wrapper;
}

export async function launch(engine: Engine, args: string[] = []): Promise<Browser> {
  // Headless Chromium hides scrollbars, and the tests drag one.
  if (engine === "chromium") return chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"], args });
  const executablePath = await webkitExecutable();
  return webkit.launch(executablePath ? { executablePath } : {});
}

/**
 * Why WebKit can't run here, if it is for want of system libraries, so its tests skip with a
 * way to fix it rather than failing the run. Playwright refuses up front when it finds the host
 * missing them, or MiniBrowser exits failing to load one; any other launch error is thrown.
 */
export async function missingWebKitLibraries(): Promise<string | null> {
  try {
    await (await launch("webkit")).close();
    return null;
  } catch (error) {
    const message = String(error);
    if (!/Host system is missing dependencies|error while loading shared libraries/.test(message)) throw error;
    const library = /error while loading shared libraries: (\S+?):/.exec(message)?.[1];
    return `WebKit is missing system libraries${library ? ` (${library})` : ""}. Put Ubuntu 24.04's libicu74 and libjpeg-turbo8 libraries in ${webkitLibs() ?? WEBKIT_LIBS_DEFAULT}, or point BORKCODE_E2E_WEBKIT_LIBS at them; see "Browser tests" in the README.`;
  }
}

/** Desktop Chromium, or an iPhone-sized touch WebKit (Playwright's WebKit can't emulate isMobile on Linux). */
export function profile(engine: Engine): BrowserContextOptions {
  return engine === "chromium"
    ? { viewport: { width: 1280, height: 800 } }
    : { ...devices["iPhone 13"], isMobile: false, hasTouch: true, viewport: { width: 390, height: 844 } };
}

/**
 * iOS keeps the layout viewport when the keyboard opens and shrinks only `visualViewport`, which
 * headless WebKit can't do; this stands in for it. `window.__keyboard(height)` opens, `()` closes.
 * It also reports a coarse pointer, so the touch composer is used as on a phone.
 */
function iosShim() {
  const target = new EventTarget();
  const state = { height: innerHeight };
  Object.defineProperties(target, {
    width: { get: () => innerWidth },
    height: { get: () => state.height },
    offsetTop: { value: 0 },
    offsetLeft: { value: 0 },
    pageTop: { value: 0 },
    pageLeft: { value: 0 },
    scale: { value: 1 },
  });
  Object.defineProperty(window, "visualViewport", { value: target });
  Object.assign(window, {
    __keyboard(height?: number) {
      state.height = height ?? innerHeight;
      target.dispatchEvent(new Event("resize"));
    },
  });
  const media = window.matchMedia.bind(window);
  window.matchMedia = (query) => {
    const result = media(query);
    if (query !== "(pointer: coarse)") return result;
    return new Proxy(result, {
      get: (target, key) => {
        if (key === "matches") return true;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
}

export type Session = { page: Page; socket: () => WebSocketRoute; close: () => Promise<void> };

/**
 * A fresh page on a thread, or on any `hash` with a composer, with the WebSocket passed through so
 * tests can add server events.
 */
export async function open(
  browser: Browser,
  engine: Engine,
  server: Server,
  threadId: string,
  {
    base = server.url,
    context: options = profile(engine),
    hash = `#/thread/${threadId}`,
  }: { base?: string; context?: BrowserContextOptions; hash?: string } = {},
): Promise<Session> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (engine === "webkit") await page.addInitScript(iosShim);
  let route: WebSocketRoute | undefined;
  await page.routeWebSocket("**/ws", (ws) => {
    ws.connectToServer();
    route = ws;
  });
  await page.goto(`${base}/${hash}`);
  await page.locator("[data-composer]").waitFor();
  return {
    page,
    socket: () => {
      if (!route) throw new Error("no WebSocket yet");
      return route;
    },
    async close() {
      await context.close();
      if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
    },
  };
}

export type { Item };
