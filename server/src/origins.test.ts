import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { networkInterfaces } from "node:os";
import { test } from "node:test";
import { loadConfig } from "./config.ts";
import { assetBase, hostName, isAllowedRequest, isLocalMcpRequest } from "./origins.ts";

const config = { host: "127.0.0.1", remoteHosts: ["machine.tail123.ts.net", "100.64.0.1", "fd7a:115c:a1e0::1"] };

test("only loopback binds are implicit, network binds and identity trust are explicit", () => {
  assert.equal(loadConfig({}).host, "127.0.0.1");
  for (const host of ["localhost", "127.0.0.1", "::1"]) assert.equal(loadConfig({ HOST: host }).host, host);
  for (const host of ["0.0.0.0", "::", "100.64.0.1", "192.168.1.1", "evil.test"]) {
    assert.throws(() => loadConfig({ HOST: host }), /Network access/);
  }

  for (const value of [undefined, "evil.test/path", "user@localhost", "localhost,evil.test", "localhost:bad", ""]) {
    assert.equal(hostName(value), null);
  }
});

test("HTTP authority, remote origins, sandbox requests and local MCP are checked on real sockets", async (t) => {
  let current = config;
  const server = createServer((req, res) => {
    const allowed = isAllowedRequest(req, current) && (req.url !== "/mcp/token" || isLocalMcpRequest(req));
    res.setHeader("x-asset-base", assetBase(req, "t", "v", current) ?? "invalid");
    res.writeHead(allowed ? 200 : 403).end();
  });
  server.listen(0, "0.0.0.0");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  async function status(headers: IncomingHttpHeaders, path = "/", hostname = "127.0.0.1", method = "GET") {
    return new Promise<number>((resolve, reject) => {
      const req = request({ hostname, port, path, headers, method }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject);
      req.end();
    });
  }
  async function base(host: string, protocol: string, hostname = "127.0.0.1") {
    return new Promise<string | undefined>((resolve, reject) => {
      const req = request({ hostname, port, headers: { host, "x-forwarded-proto": protocol, "x-forwarded-host": host } }, (res) => {
        res.resume(); resolve(res.headers["x-asset-base"] as string | undefined);
      });
      req.on("error", reject);
      req.end();
    });
  }
  assert.equal(await base(config.remoteHosts[0]!, "http"), `http://${config.remoteHosts[0]}/api/threads/t/visualizations/v/`);
  assert.equal(await base(config.remoteHosts[0]!, "https"), `https://${config.remoteHosts[0]}/api/threads/t/visualizations/v/`);
  assert.equal(await base(`localhost:${port}`, "https"), `http://localhost:${port}/api/threads/t/visualizations/v/`);
  assert.equal(await base("other.tail123.ts.net", "https"), "http://other.tail123.ts.net/api/threads/t/visualizations/v/");
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, "[::1]:4800", config.remoteHosts[0]!]) {
    assert.equal(await status({ host }), 200);
  }
  assert.equal(await status({ host: "[fd7a:115c:a1e0::1]:4800" }), 200);
  assert.equal(await status({ host: "rebind.example" }), 403);
  assert.equal(await status({ host: "localhost", "x-forwarded-host": config.remoteHosts[0]! }), 403);
  assert.equal(await status({ host: "evil.test", "x-forwarded-host": config.remoteHosts[0]! }), 403);
  assert.equal(await status({ host: config.remoteHosts[0]!, "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-user": "?1" }), 200);
  assert.equal(await status({ host: config.remoteHosts[0]!, "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe", "sec-fetch-user": "?1" }), 403);
  const assetPath = "/api/threads/11111111-1111-4111-8111-111111111111/visualizations/22222222-2222-4222-8222-222222222222/assets/font.woff2";
  const assetHeaders = { host: config.remoteHosts[0]!, origin: "null", "sec-fetch-site": "cross-site", "x-forwarded-for": "100.64.0.1" };
  assert.equal(await status(assetHeaders, assetPath), 200);
  const { origin: _, ...assetWithoutOrigin } = assetHeaders;
  assert.equal(await status(assetWithoutOrigin, assetPath), 200);
  assert.equal(await status({ ...assetHeaders, origin: "https://evil.test" }, assetPath), 403);
  assert.equal(await status({ ...assetHeaders, host: "evil.test" }, assetPath), 403);
  assert.equal(await status({ ...assetHeaders, host: "localhost" }, assetPath), 403);
  assert.equal(await status({ ...assetHeaders, "tailscale-funnel-request": "?1" }, assetPath), 403);
  assert.equal(await status(assetHeaders, assetPath, "127.0.0.1", "POST"), 403);
  for (const path of ["/api/threads/t/files", "/api/threads/t/attachments", "/ws",
    "/api/threads/t/visualizations/v/", "/api/threads/t/visualizations/v", "/favicon.svg"]) {
    assert.equal(await status(assetHeaders, path), 403, path);
  }
  const remote = { host: config.remoteHosts[0]!, origin: `https://${config.remoteHosts[0]}` };
  assert.equal(await status(remote), 200);
  assert.equal(await status({ ...remote, origin: "https://evil.test" }), 403);
  assert.equal(await status({ ...remote, origin: "null" }), 403);
  assert.equal(await status({ host: remote.host, "sec-fetch-site": "cross-site" }, "/favicon.svg"), 403);
  assert.equal(await status({ ...remote, "tailscale-funnel-request": "?1" }), 403);
  assert.equal(await status({ host: "localhost" }, "/mcp/token"), 200);
  for (const headers of [remote, { host: "localhost", origin: "http://localhost" },
    { host: "localhost", "sec-fetch-site": "same-origin" },
    { host: "localhost", "x-forwarded-for": "100.64.0.1" }, { host: "localhost", "tailscale-user-login": "me@example.com" }]) {
    assert.equal(await status(headers, "/mcp/token"), 403);
  }
  const network = Object.values(networkInterfaces()).flat().find((address) => address?.family === "IPv4" && !address.internal);
  assert.ok(network, "a network interface is needed to exercise non-loopback MCP requests");
  assert.equal(await status({ host: "localhost" }, "/mcp/token", network.address), 403);
  assert.equal(await base(config.remoteHosts[0]!, "https", network.address), `http://${config.remoteHosts[0]}/api/threads/t/visualizations/v/`);
  assert.equal(await status(assetHeaders, assetPath, network.address), 403);
  assert.equal(await status({ host: "192.168.1.10" }), 403);
  current = { ...config, remoteHosts: [] };
  assert.equal(await status(assetHeaders, assetPath), 403);
  assert.equal(await status(remote), 403);
  assert.equal(await status({ host: "localhost" }), 200);
  assert.equal(await status({ host: "localhost" }, "/mcp/token"), 200);
});
