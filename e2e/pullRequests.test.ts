import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { launch, profile, startServer, type Server } from "./harness.ts";

const OPEN = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
let server: Server;

before(async () => {
  server = await startServer([
    { id: OPEN, title: "Selected thread", items: [] },
    { id: OTHER, title: "Other thread", items: [] },
  ]);
});
after(async () => server?.stop());

for (const engine of ["chromium", "webkit"] as const) {
  test(`${engine}: reconnecting on return refreshes unopened threads' sidebar PR symbols`, async () => {
    let browser: Browser | undefined;
    try {
      browser = await launch(engine);
      const context = await browser.newContext(profile(engine));
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      await page.addInitScript(() => localStorage.setItem("borkcode.sidebarFilter", JSON.stringify({ hideInactive: false })));
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let state = "OPEN";
      let connections = 0;
      let refreshes = 0;
      const linked = (state: string) => [{ repo: "app", number: 1, url: "https://github.com/me/app/pull/1", state, title: "PR", headOid: "abc" }];
      await page.routeWebSocket("**/ws", (ws) => {
        connections++;
        const upstream = ws.connectToServer();
        upstream.onMessage((message) => ws.send(message));
        ws.onMessage((message) => {
          const request = JSON.parse(String(message)) as { id: number; method: string };
          if (request.method === "pullRequests.list") {
            ws.send(JSON.stringify({ id: request.id, result: { [OTHER]: linked("OPEN") } }));
          } else if (request.method === "pullRequests.refresh") {
            refreshes++;
            ws.send(JSON.stringify({ event: { type: "pullRequests.changed", threadId: OTHER, pullRequests: linked(state) } }));
            ws.send(JSON.stringify({ id: request.id, result: null }));
          } else upstream.send(message);
        });
      });
      await page.goto(`${server.url}/#/thread/${OPEN}`);
      await page.locator("[data-composer]").waitFor();
      const other = page.locator("nav .thread", { hasText: "Other thread" });
      await other.locator(".pr-open").waitFor({ state: "attached" });
      const before = refreshes;
      state = "MERGED";
      // Keep the server's cached snapshot OPEN; the refresh event supplies GitHub's new state.
      // RpcClient replaces the socket before state.svelte's visibility listener runs.
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await other.locator(".pr-merged").waitFor({ state: "attached" });
      assert.equal(connections, 2);
      assert.equal(refreshes, before + 1);
      assert.equal(await other.locator(".pr-open").count(), 0);
      assert.ok(page.url().endsWith(OPEN), "the other thread was never opened");
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
    }
  });
}
