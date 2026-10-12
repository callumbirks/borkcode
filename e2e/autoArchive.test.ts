// Automatic archiving from the Settings page: the switch and days persist across reloads, and
// turning it on archives a seeded old thread, which shows on the Archived page with its notice.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { launch, profile, startServer, type Server } from "./harness.ts";

const OLD = "77777777-7777-4777-8777-777777777777";
const FRESH = "88888888-8888-4888-8888-888888888888";
const DAY = 24 * 60 * 60 * 1000;

let server: Server;
let browser: Browser;

before(async () => {
  server = await startServer(
    [
      { id: OLD, title: "Old thread", items: [{ id: "old-a", kind: "assistant", text: "Long done." }], updatedAt: Date.now() - 20 * DAY },
      { id: FRESH, title: "Fresh thread", items: [{ id: "fresh-a", kind: "assistant", text: "Just now." }] },
    ],
    {},
    // Off at first, so the server's start-up run leaves the old thread alone.
    { autoArchive: { enabled: false, days: 7 } },
  );
  browser = await launch("chromium");
});

after(async () => {
  await browser?.close();
  await server?.stop();
});

test("turning on automatic archiving persists and archives the old thread with a notice", async () => {
  const context = await browser.newContext(profile("chromium"));
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Resolves on the server's next settings broadcast, which follows the save.
  let settingsChanged = () => {};
  await page.routeWebSocket("**/ws", (ws) => {
    const upstream = ws.connectToServer();
    upstream.onMessage((message) => {
      ws.send(message);
      if (String(message).includes('"settings.changed"')) settingsChanged();
    });
  });
  const saved = () => new Promise<void>((resolve) => (settingsChanged = resolve));

  await page.goto(`${server.url}/#/archived`);
  await page.getByText("No archived threads.").waitFor();

  await page.goto(`${server.url}/#/settings`);
  const toggle = page.getByRole("switch", { name: "Archive inactive threads" });
  const days = page.getByRole("spinbutton", { name: "Days inactive" });
  assert.equal(await toggle.isChecked(), false);
  assert.equal(await days.inputValue(), "7");

  // 30 days keeps the 20-day-old thread, even once switched on.
  let save = saved();
  await days.fill("30");
  await days.blur();
  await save;
  save = saved();
  await toggle.check({ force: true });
  await save;
  await page.reload();
  await toggle.waitFor({ state: "attached" });
  assert.equal(await toggle.isChecked(), true);
  assert.equal(await days.inputValue(), "30");
  await page.goto(`${server.url}/#/archived`);
  await page.getByText("No archived threads.").waitFor();

  // Shortening the wait runs archiving at once.
  await page.goto(`${server.url}/#/settings`);
  save = saved();
  await days.fill("10");
  await days.blur();
  await save;
  await page.goto(`${server.url}/#/archived`);
  await page.locator(".list-row", { hasText: "Old thread" }).waitFor();
  assert.equal(await page.locator(".list-row", { hasText: "Fresh thread" }).count(), 0);

  await page.locator(".list-row", { hasText: "Old thread" }).click();
  await page.locator(".notice.info", { hasText: "Archived automatically after 10 days inactive" }).waitFor();

  await page.reload();
  await page.goto(`${server.url}/#/settings`);
  assert.equal(await days.inputValue(), "10");
  await context.close();
  assert.deepEqual(errors, []);
});
