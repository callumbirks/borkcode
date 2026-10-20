// Long threads open with their latest turns, and earlier ones load as the user scrolls up, with
// the row being read staying where it was. Desktop Chromium and an iPhone-sized touch WebKit.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Browser, Page } from "playwright";
import { launch, missingWebKitLibraries, open, startServer, type Engine, type Item, type Server } from "./harness.ts";

const THREAD = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
const TURNS = 100;
const paragraph = "A paragraph with enough words to wrap a few times on a phone and once on a desktop. ";
const label = (turn: number) => `Q-${String(turn).padStart(3, "0")}`;

/** About 1,000 items: each turn asks, runs a few tools and answers at some length. */
const items: Item[] = Array.from({ length: TURNS }, (_, turn): Item[] => [
  { id: `u${turn}`, kind: "user", text: `${label(turn)} question` },
  ...Array.from({ length: 8 }, (_, step): Item => ({
    id: `t${turn}-${step}`, kind: "tool", name: "shell", summary: `step ${step}`, output: `output ${step}\n`.repeat(20), status: "done",
  })),
  { id: `a${turn}`, kind: "assistant", text: `Answer ${turn}\n\n` + (paragraph.repeat(3) + "\n\n").repeat((turn % 3) + 1) },
]).flat();

const settle = (page: Page) =>
  page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done)))));

const gap = (page: Page) =>
  page.evaluate(() => {
    const transcript = document.querySelector<HTMLElement>(".transcript")!;
    return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
  });

async function assertPinned(page: Page, what: string) {
  await settle(page);
  const left = await gap(page);
  assert.ok(left < 2, `${what}: ${left}px above the bottom`);
}

/** Which turns' questions are in the page. */
const loadedTurns = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".transcript .user")].flatMap((row) => /Q-(\d+)/.exec(row.textContent ?? "")?.[1] ?? []).map(Number),
  );

/** Scrolls up as the user would, a screen at a time, until the transcript nears its top. */
async function scrollUpUntil(page: Page, engine: Engine, done: () => Promise<boolean>) {
  for (let i = 0; i < 40 && !(await done()); i++) {
    if (engine === "chromium") {
      await page.locator(".transcript").hover();
      await page.mouse.wheel(0, -1500);
    } else {
      await page.evaluate(async () => {
        const transcript = document.querySelector<HTMLElement>(".transcript")!;
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        transcript.dispatchEvent(new Event("touchstart", { bubbles: true }));
        for (let step = 0; step < 5; step++) {
          transcript.scrollTop -= 300;
          await frame();
        }
        transcript.dispatchEvent(new Event("touchend", { bubbles: true }));
        await frame();
      });
    }
    await settle(page);
  }
  assert.ok(await done(), "scrolled up far enough");
}

/** The first row showing at the top of the transcript, remembered, and where it is. */
const markAnchor = (page: Page) =>
  page.evaluate(() => {
    const transcript = document.querySelector<HTMLElement>(".transcript")!;
    const top = transcript.getBoundingClientRect().top;
    const rows = [...transcript.querySelectorAll(".column > :not(.older)")];
    const anchor = rows.find((row) => row.getBoundingClientRect().bottom > top + 1)!;
    (window as unknown as { anchor: Element }).anchor = anchor;
    return anchor.getBoundingClientRect().top - top;
  });

const anchorTop = (page: Page) =>
  page.evaluate(() => {
    const transcript = document.querySelector<HTMLElement>(".transcript")!;
    const anchor = (window as unknown as { anchor: Element }).anchor;
    return anchor.isConnected ? anchor.getBoundingClientRect().top - transcript.getBoundingClientRect().top : null;
  });

const engines = (process.env.E2E_BROWSERS ?? "chromium,webkit").split(",") as Engine[];
const webkitMissing = engines.includes("webkit") ? await missingWebKitLibraries() : null;
if (webkitMissing) console.warn(webkitMissing);

for (const engine of engines) {
  describe(`older turns (${engine})`, { skip: (engine === "webkit" && webkitMissing) || false }, () => {
    let server: Server;
    let browser: Browser;
    before(async () => {
      server = await startServer([{ id: THREAD, title: "Very long thread", items }]);
      browser = await launch(engine);
    });
    after(async () => {
      await browser?.close();
      await server?.stop();
    });

    test("a long thread opens with its last 20 turns, loads earlier ones in place, and still follows live items", async () => {
      // Each request for earlier turns waits until the test lets it through.
      let release = () => {};
      let requested = 0;
      const session = await open(browser, engine, server, THREAD, {
        beforeRequest: (method) => {
          if (method !== "items.older") return;
          requested++;
          return new Promise<void>((done) => (release = done));
        },
      });
      const { page } = session;
      await page.getByText(`${label(TURNS - 1)} question`).waitFor();
      await assertPinned(page, "opened");
      assert.deepEqual(await loadedTurns(page), Array.from({ length: 20 }, (_, i) => TURNS - 20 + i));
      assert.equal(requested, 0, "nothing more loads while the view sits at the bottom");

      for (const round of [1, 2]) {
        await scrollUpUntil(page, engine, async () => requested === round);
        await page.getByText("Loading earlier turns…").waitFor();
        await settle(page);
        const before = await markAnchor(page);
        release();
        const first = TURNS - 20 * (round + 1);
        await page.getByText(`${label(first)} question`).waitFor({ state: "attached" });
        await settle(page);
        const after = await anchorTop(page);
        assert.ok(after !== null && Math.abs(after - before) < 2, `page ${round}: the row being read moved from ${before} to ${after}`);
        assert.deepEqual(await loadedTurns(page), Array.from({ length: TURNS - first }, (_, i) => first + i));
        await page.getByText("Loading earlier turns…").waitFor({ state: "detached" });
      }
      assert.equal(requested, 2, "one request at a time");

      // Back at the bottom, live items are followed again.
      if (engine === "chromium") await page.mouse.wheel(0, 1_000_000);
      else await page.evaluate(() => (document.querySelector<HTMLElement>(".transcript")!.scrollTop = 1_000_000));
      await settle(page);
      await assertPinned(page, "back at the bottom");
      const send = (event: object) => session.socket().send(JSON.stringify({ event }));
      send({ type: "item.upserted", threadId: THREAD, seq: 1_000_000, item: { id: "live", kind: "assistant", text: (paragraph.repeat(4) + "\n\n").repeat(3) + "LIVE-END" } });
      await page.getByText("LIVE-END").waitFor();
      await assertPinned(page, "after a live item");
      // An update to an item in a turn that isn't loaded doesn't land at the end.
      send({ type: "item.upserted", threadId: THREAD, seq: 1, item: { id: "u0", kind: "user", text: "NOT-LOADED" } });
      send({ type: "item.upserted", threadId: THREAD, seq: 1_000_001, item: { id: "live-2", kind: "assistant", text: "LIVE-AFTER" } });
      await page.getByText("LIVE-AFTER").waitFor();
      assert.equal(await page.getByText("NOT-LOADED").count(), 0);
      await assertPinned(page, "after the second live item");
      await session.close();
    });
  });
}
