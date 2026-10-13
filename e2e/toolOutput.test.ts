// Trimmed tool output: a thread opens without its finished tool calls' output, and expanding a step
// fetches it. The view stays pinned to the bottom while the output arrives. Desktop Chromium and
// an iPhone-sized touch WebKit.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Browser, Locator, Page } from "playwright";
import { launch, missingWebKitLibraries, open, startServer, type Engine, type Item, type Server } from "./harness.ts";

const THREAD = "abababab-abab-4bab-8bab-abababababab";
const paragraph = "A paragraph with enough words to wrap a few times on a phone and once on a desktop. ";
const output = Array.from({ length: 400 }, (_, i) => `log line ${i}`).join("\n") + "\nOUTPUT-END";

const items: Item[] = [
  ...Array.from({ length: 20 }, (_, i): Item[] => [
    { id: `u${i}`, kind: "user", text: `Question ${i}` },
    { id: `a${i}`, kind: "assistant", text: (paragraph.repeat(3) + "\n\n").repeat(2) },
  ]).flat(),
  { id: "quick", kind: "tool", name: "shell", summary: "pwd", output: "/tmp/app", status: "done" },
  { id: "big", kind: "tool", name: "shell", summary: "cat big.log", output, status: "done" },
  { id: "end", kind: "assistant", text: "LAST-TOOLS" },
];

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

const press = (engine: Engine, target: Locator) => (engine === "webkit" ? target.tap() : target.click());

const engines = (process.env.E2E_BROWSERS ?? "chromium,webkit").split(",") as Engine[];
const webkitMissing = engines.includes("webkit") ? await missingWebKitLibraries() : null;
if (webkitMissing) console.warn(webkitMissing);

for (const engine of engines) {
  describe(`trimmed tool output (${engine})`, { skip: (engine === "webkit" && webkitMissing) || false }, () => {
    let server: Server;
    let browser: Browser;
    before(async () => {
      server = await startServer([{ id: THREAD, title: "Tool thread", items }]);
      browser = await launch(engine);
    });
    after(async () => {
      await browser?.close();
      await server?.stop();
    });

    test("expanding a step fetches its output, and a pinned view stays pinned", async () => {
      const session = await open(browser, engine, server, THREAD);
      const { page } = session;
      await page.getByText("LAST-TOOLS").waitFor();
      await assertPinned(page, "opened");

      const group = page.locator("details.group").last();
      await press(engine, group.locator("summary").first());
      const step = group.locator("details.step", { hasText: "cat big.log" });
      await step.waitFor();
      await assertPinned(page, "group expanded");
      // Closed steps used to carry their output in the page; trimmed ones have none until asked.
      assert.equal(await page.locator("pre.body").count(), 0);

      await press(engine, step.locator("summary"));
      await step.locator("pre.body", { hasText: "OUTPUT-END" }).waitFor();
      assert.equal(await step.locator("pre.body").textContent(), output);
      await assertPinned(page, "output loaded");
      // Only the expanded step was fetched.
      assert.equal(await group.locator("details.step", { hasText: "pwd" }).locator("pre.body").count(), 0);
      await session.close();
    });
  });
}
