import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { tailscaleAddresses, isTailscaleAddress, serveEndpoint, NetworkAccess, type Tailnet } from "./network.ts";

test("only Tailscale IPv4 and IPv6 ranges are selected", () => {
  for (const ip of ["100.64.0.1", "100.127.255.254", "::ffff:100.64.0.1", "fd7a:115c:a1e0::1", "FD7A:115C:A1E0:0:0:0:0:1"]) assert.ok(isTailscaleAddress(ip), ip);
  for (const ip of ["0.0.0.0", "::", "127.0.0.1", "192.168.1.1", "10.0.0.1", "100.63.255.255", "100.128.0.1", "fd7a:115c:a1e1::1", "example.com"]) assert.equal(isTailscaleAddress(ip), false, ip);
});

test("toggle and rediscovery change only tailnet listeners, preserving loopback", async (t) => {
  const local = createServer((_req, res) => res.end("local"));
  local.listen(0, "127.0.0.1");
  await once(local, "listening");
  t.after(() => new Promise<void>((resolve) => local.close(() => resolve())));
  const port = (local.address() as { port: number }).port;
  let found: Tailnet = { addresses: [], dnsName: null, httpsUrl: null };
  const opened: string[] = [];
  const closed: string[] = [];
  const changes: boolean[] = [];
  let detections = 0;
  // Use a second loopback address for real test sockets; assert every requested bind separately.
  const access = new NetworkAccess(port, "127.0.0.1", async (address) => {
    opened.push(address);
    const listener = createServer((_req, res) => res.end("remote"));
    listener.listen(port, "127.0.0.2");
    await once(listener, "listening");
    return () => new Promise<void>((resolve) => { closed.push(address); listener.closeAllConnections(); listener.close(() => resolve()); });
  }, (state) => changes.push(state.enabled), async () => { detections++; return found; }, async () => true);
  t.after(() => access.refresh(false));
  await access.refresh(false);
  assert.equal(detections, 0);
  await access.refresh(true);
  assert.match(access.state.message!, /Tailscale isn't available/);
  found = { addresses: ["100.64.0.1", "192.168.1.1", "0.0.0.0"], dnsName: "machine.tail123.ts.net", httpsUrl: "https://machine.tail123.ts.net/" };
  await access.refresh(true);
  assert.deepEqual(opened, ["100.64.0.1"]);
  assert.equal(await (await fetch(`http://127.0.0.2:${port}/`)).text(), "remote");
  assert.ok(access.state.endpoints.some((entry) => entry.url === `http://100.64.0.1:${port}/`));
  assert.ok(access.state.endpoints.some((entry) => entry.label === "Tailscale HTTPS (Serve)"));
  await access.refresh(true);
  assert.equal(opened.length, 1);
  await access.refresh(false);
  assert.deepEqual(closed, ["100.64.0.1"]);
  assert.deepEqual(access.policy.remoteHosts, []);
  assert.equal(access.state.endpoints.length, 1);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "local");
  assert.deepEqual(changes, [true, true, false]);
  found = { addresses: ["100.64.0.2"], dnsName: null, httpsUrl: null };
  await access.refresh(true);
  assert.deepEqual(opened, ["100.64.0.1", "100.64.0.2"]);
});

test("Serve URLs advertise only HTTPS rooted at this borkcode port", () => {
  const dnsName = "machine.tail123.ts.net";
  const config = { TCP: { "443": { HTTPS: true } }, Web: { [`${dnsName}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4800" } } } } };
  assert.equal(serveEndpoint(config, dnsName, 4800), `https://${dnsName}/`);
  assert.equal(serveEndpoint(config, dnsName, 4801), null);
  assert.equal(serveEndpoint(config, "other.tail123.ts.net", 4800), null);
  assert.equal(serveEndpoint({ ...config, TCP: { "443": { HTTPS: false } } }, dnsName, 4800), null);
  assert.equal(serveEndpoint({ TCP: config.TCP, Web: { [`${dnsName}:443`]: { Handlers: { "/other": { Proxy: "http://127.0.0.1:4800" } } } } }, dnsName, 4800), null);
  assert.equal(serveEndpoint({ TCP: config.TCP, Web: { [`${dnsName}:443`]: { Handlers: { "/": { Proxy: "http://192.168.1.1:4800" } } } } }, dnsName, 4800), null);
});


test("CLI self addresses are authoritative, including when stopped", () => {
  const interfaces = { eth0: [entry("100.80.0.1")], tailscale0: [entry("100.80.0.2")] };
  assert.deepEqual(tailscaleAddresses(interfaces, "linux", { BackendState: "Running", Self: { TailscaleIPs: ["100.80.0.3", "fd7a:115c:a1e0::3", "192.168.1.1", "100.80.0.3"] } }), ["100.80.0.3", "fd7a:115c:a1e0::3"]);
  assert.deepEqual(tailscaleAddresses(interfaces, "linux", { BackendState: "Stopped" }), []);
  assert.deepEqual(tailscaleAddresses(interfaces, "linux", { BackendState: "Running", Self: {} }), []);
});

test("interface fallback rejects ISP CGNAT and unrelated VPN interfaces", () => {
  const interfaces = {
    eth0: [entry("100.80.0.1")], en0: [entry("100.80.0.4")],
    tailscale0: [entry("100.80.0.2"), entry("192.168.1.1")],
    utun100: [entry("100.80.0.3"), entry("fd7a:115c:a1e0::3")],
    utun1: [entry("10.0.0.1")], utunother: [entry("100.80.0.5")],
  };
  assert.deepEqual(tailscaleAddresses(interfaces, "linux", null), ["100.80.0.2"]);
  assert.deepEqual(tailscaleAddresses(interfaces, "darwin", null), ["100.80.0.3", "fd7a:115c:a1e0::3"]);
  assert.deepEqual(tailscaleAddresses(interfaces, "win32", null), []);
});

function entry(address: string): import("node:os").NetworkInterfaceInfo {
  return { address, netmask: "255.255.255.255", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: `${address}/32` };
}
