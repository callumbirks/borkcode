// Provider commands and compaction: `/` at the start of the composer opens the provider's commands,
// filtered as you type, picked with the keyboard or a tap; `/compact` on a Codex thread runs the
// fake CLI's compaction, shown as compacting until it finishes and then as a lasting marker. A
// Claude compaction with a summary, as the adapter records it, shows the summary collapsed.
// The new-thread page offers only commands that can open a thread, from a stubbed Claude list put
// through the server's own filter. Desktop Chromium and an iPhone-sized touch WebKit.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Browser, Page } from "playwright";
import { claudeCommands } from "../server/src/providers/claude.ts";
import { launch, missingWebKitLibraries, open, startServer, type Engine, type Item, type Server } from "./harness.ts";

const THREAD = "99999999-9999-4999-8999-999999999999";
const SUMMARIZED = "99999999-9999-4999-8999-999999999998";
// As Claude's supportedCommands() lists them, with a bundled skill and a TUI command left out.
const claude = claudeCommands([
  { name: "simplify", description: "Review the changed code", argumentHint: "", builtin: true },
  { name: "compact", description: "Free up context by summarizing the conversation so far", argumentHint: "<optional custom summarization instructions>", builtin: true },
  { name: "config", description: "Set a setting by key", argumentHint: "key=value", builtin: true },
  { name: "context", description: "Show current context usage", argumentHint: "", builtin: true },
  { name: "usage", description: "Show session cost, plan usage, and what's contributing to your limits", argumentHint: "", builtin: true },
]);
const summarized: Item = {
  id: "claude-compaction",
  kind: "compaction",
  status: "done",
  trigger: "auto",
  tokensBefore: 167_000,
  tokensAfter: 12_400,
  summary: "1. **Primary request:** port the parser.\n2. Files: `src/parse.ts`.",
};

const engines = (process.env.E2E_BROWSERS ?? "chromium,webkit").split(",") as Engine[];
const webkitMissing = engines.includes("webkit") ? await missingWebKitLibraries() : null;
if (webkitMissing) console.warn(webkitMissing);

const menu = (page: Page) => page.getByRole("listbox", { name: "Commands" });
const options = (page: Page) => menu(page).getByRole("option").locator(".title").allTextContents();
// Enter adds a line in the touch composer, so both tap Send.
const send = (page: Page) => page.getByRole("button", { name: "Send", exact: true }).click();
const draft = (page: Page, engine: Engine) => {
  const composer = page.locator("[data-composer]");
  return engine === "chromium" ? composer.textContent() : composer.inputValue();
};

for (const engine of engines) {
  describe(`provider commands (${engine})`, { skip: (engine === "webkit" && webkitMissing) || false }, () => {
    let server: Server;
    let browser: Browser;
    before(async () => {
      server = await startServer([
        { id: THREAD, title: "Long thread", items: [{ id: "a", kind: "assistant", text: "Hello." }] },
        { id: SUMMARIZED, title: "Summarized thread", items: [{ id: "b", kind: "assistant", text: "Earlier work." }, summarized] },
      ]);
      browser = await launch(engine);
    });
    after(async () => {
      await browser?.close();
      await server?.stop();
    });

    test("/ offers the provider's commands, filtered, picked and sent; /compact shows compacting, then a marker", async () => {
      const { page, close } = await open(browser, engine, server, THREAD);
      const composer = page.locator("[data-composer]");

      // A message first, so the context has a size to compact from.
      await composer.click();
      await page.keyboard.type("Start");
      await send(page);
      await page.getByText("Reply finished.").waitFor();

      // Only at the very start of the message.
      await page.keyboard.type("see /");
      assert.equal(await menu(page).count(), 0);
      await composer.fill("");

      await page.keyboard.type("/");
      assert.deepEqual(await options(page), ["/compact"]);
      await page.keyboard.type("q");
      await menu(page).waitFor({ state: "detached" });
      await page.keyboard.press("Backspace");
      await menu(page).waitFor();
      await page.keyboard.press("Escape");
      await menu(page).waitFor({ state: "detached" });
      await page.keyboard.press("Backspace");
      await page.keyboard.type("/co");
      assert.deepEqual(await options(page), ["/compact"]);
      assert.equal(await menu(page).getByRole("option", { selected: true }).locator(".detail").textContent(), "Summarize the conversation so far to free up context");
      if (engine === "chromium") await page.keyboard.press("Tab");
      else await menu(page).getByRole("option").first().tap();
      await menu(page).waitFor({ state: "detached" });
      assert.equal(await draft(page, engine), "/compact ");

      await send(page);
      // The message shows the command as such, and the thread shows it is compacting.
      await page.locator(".user code.command", { hasText: "/compact" }).waitFor();
      await page.locator(".status", { hasText: "Compacting…" }).waitFor();
      await page.locator(".compaction.running", { hasText: "Compacting context…" }).waitFor();

      await writeFile(join(server.home, "release-compaction"), "");
      const marker = page.locator(".compaction.done");
      await marker.waitFor();
      assert.equal((await marker.textContent())?.replace(/\s+/g, " ").trim(), "Context compacted · manual · 16k → 10k tokens");
      await page.locator(".status").waitFor({ state: "detached" });
      // No summary from Codex, so nothing to open.
      assert.equal(await marker.locator("details, summary").count(), 0);
      await close();
    });

    test("a compaction's summary is collapsed under its marker until opened", async () => {
      const { page, close } = await open(browser, engine, server, SUMMARIZED);
      const marker = page.locator("details.compaction");
      await marker.waitFor();
      assert.equal((await marker.locator("summary").textContent())?.replace(/\s+/g, " ").trim(), "Context compacted · automatically · 167k → 12.4k tokens");
      const summary = marker.locator(".compaction-summary");
      assert.equal(await summary.isVisible(), false);
      await marker.locator("summary").click();
      await summary.locator("strong", { hasText: "Primary request:" }).waitFor();
      await close();
    });

    test("the new-thread page offers only commands that can open a thread", async () => {
      const { page, close } = await open(browser, engine, server, THREAD, { hash: "#/project/demo/new", commands: { claude } });
      const composer = page.locator("[data-composer]");
      await composer.click();
      // Claude is the default agent; /compact needs a conversation, so it is not offered here.
      await page.keyboard.type("/");
      assert.deepEqual(await options(page), ["/context", "/usage"]);
      await page.keyboard.type("u");
      assert.deepEqual(await options(page), ["/usage", "/context"]);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      assert.equal(await draft(page, engine), "/context ");
      await composer.fill("");
      await close();
    });
  });
}
