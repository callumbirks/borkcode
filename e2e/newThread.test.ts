// The new-thread page: the sidebar's "+" opens it, its draft survives reloads and navigation, the
// role and workspace pickers show only there, and sending with a file lands on the new thread
// with the file shown and the draft cleared. Desktop Chromium and an iPhone-sized touch WebKit.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Browser, Page } from "playwright";
import { launch, missingWebKitLibraries, open, startServer, type Engine, type Server } from "./harness.ts";

const EXISTING = "77777777-7777-4777-8777-777777777777";
const TEXT = { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("plover\n") };

const engines = (process.env.E2E_BROWSERS ?? "chromium,webkit").split(",") as Engine[];
const webkitMissing = engines.includes("webkit") ? await missingWebKitLibraries() : null;
if (webkitMissing) console.warn(webkitMissing);

/** The new-thread draft as saved in this browser, once its debounced write lands. */
async function savedDraft(page: Page, expected: (draft: string | undefined) => boolean) {
  const handle = await page.waitForFunction(
    (source) => {
      const draft = JSON.parse(localStorage.getItem("borkcode.drafts") ?? "{}")["new:demo"] as string | undefined;
      return new Function("draft", `return (${source})(draft)`)(draft) ? { draft } : null;
    },
    expected.toString(),
  );
  return ((await handle.jsonValue()) as { draft?: string }).draft;
}

/**
 * The agent, role and workspace the new-thread composer shows: the row's picker and icon toggles
 * on desktop, the options sheet's labelled rows on a phone.
 */
async function picksShown(page: Page, engine: Engine) {
  const scope = engine === "chromium" ? page.locator(".desktop-options") : page.locator("dialog[open]");
  const selected = (label: string) =>
    scope.locator(`select[aria-label="${label}"]`).evaluate((select: HTMLSelectElement) => select.selectedOptions[0]!.text);
  if (engine === "chromium") {
    const state = (name: string) => scope.locator(`button[aria-label^="${name}: "]`).getAttribute("aria-label");
    return { agent: await selected("Agent"), role: await state("Role"), workspace: await state("Workspace") };
  }
  await page.locator(".phone-options .summary").click();
  const role = (await selected("Role")) === "Captain" ? "Role: captain" : "Role: thread";
  const workspace = (await selected("Workspace")) === "Main checkouts" ? "Workspace: main checkouts" : "Workspace: new worktree";
  const result = { agent: await selected("Agent"), role, workspace };
  await scope.getByRole("button", { name: "Done" }).click();
  return result;
}

async function pick(page: Page, engine: Engine, choice: { agent?: string; captain?: boolean }) {
  if (engine === "chromium") {
    if (choice.agent) await page.locator('.desktop-options select[aria-label="Agent"]').selectOption(choice.agent);
    if (choice.captain) await page.getByRole("button", { name: "Role: thread" }).click();
    return;
  }
  await page.locator(".phone-options .summary").click();
  const sheet = page.locator("dialog[open]");
  if (choice.agent) await sheet.locator('select[aria-label="Agent"]').selectOption(choice.agent);
  if (choice.captain) await sheet.locator('select[aria-label="Role"]').selectOption({ label: "Captain" });
  await sheet.getByRole("button", { name: "Done" }).click();
}

const NEW = { role: "Role: thread", workspace: "Workspace: new worktree" };

for (const engine of engines) {
  describe(`new thread (${engine})`, { skip: (engine === "webkit" && webkitMissing) || false }, () => {
    let server: Server;
    let browser: Browser;
    before(async () => {
      server = await startServer([
        { id: EXISTING, title: "Existing thread", items: [{ id: "e-a", kind: "assistant", text: "Hello." }] },
      ]);
      browser = await launch(engine);
    });
    after(async () => {
      await browser?.close();
      await server?.stop();
    });

    test("+ opens the page, the draft persists, and sending a file lands on the new thread", async () => {
      const { page, close } = await open(browser, engine, server, EXISTING);
      // A thread's composer has no role or workspace to choose.
      assert.equal(await page.locator('select[aria-label="Role"], button[aria-label^="Role:"]').count(), 0);

      if (engine === "webkit") await page.getByRole("button", { name: "Open navigation" }).click();
      await page.getByTitle("New thread in demo").click();
      await page.waitForURL(/#\/project\/demo\/new$/);
      await page.getByText("New thread", { exact: true }).waitFor();
      assert.equal(await page.locator(".question").count(), 0);

      assert.deepEqual(await picksShown(page, engine), { agent: "Claude", ...NEW });
      // Never remembered: choosing Captain now still starts the next visit as a Thread.
      await pick(page, engine, { captain: true });
      assert.deepEqual(await picksShown(page, engine), { agent: "Claude", role: "Role: captain", workspace: "Workspace: new worktree" });

      // @ searches the project's main checkouts, since the thread has no worktree yet.
      const composer = page.locator("[data-composer]");
      await composer.click();
      await page.keyboard.type("Read @ONBOA");
      await page.locator(".mention", { hasText: "ONBOARDING.md" }).waitFor();
      await page.keyboard.press("Enter");
      await page.keyboard.type("and summarise it");
      if (engine === "chromium") await composer.locator(".file-chip", { hasText: "ONBOARDING.md" }).waitFor();
      const draft = "Read @app/ONBOARDING.md and summarise it";
      assert.equal(await savedDraft(page, (text) => !!text?.includes("summarise")), draft);
      // Desktop shows the reference as a chip with the file's name; touch keeps a plain textarea.
      const shown = engine === "chromium" ? "Read ONBOARDING.md and summarise it" : draft;
      // Chips render once the project's repos are known, which can follow the draft after a reload.
      const text = async () => {
        if (engine === "webkit") return composer.inputValue();
        await composer.locator(".file-chip", { hasText: "ONBOARDING.md" }).waitFor();
        return composer.textContent();
      };

      await page.reload();
      await composer.waitFor();
      assert.equal(await text(), shown);
      assert.deepEqual(await picksShown(page, engine), { agent: "Claude", ...NEW });

      await page.evaluate(() => (location.hash = "#/project/demo"));
      await page.getByRole("button", { name: "New thread", exact: true }).click();
      await page.waitForURL(/#\/project\/demo\/new$/);
      assert.equal(await text(), shown);
      await pick(page, engine, { agent: "codex" });

      // Uploads wait in the draft's folder until the thread exists. If they are gone by then, the
      // send fails on the page and leaves the draft and the file as they were.
      await page.locator('input[type="file"]').setInputFiles([TEXT]);
      await page.locator(".strip .chip").waitFor();
      await page.locator(".strip .progress").waitFor({ state: "detached" });
      const drafts = join(server.home, "attachments", "drafts");
      assert.equal((await readdir(drafts)).length, 1);
      await rm(drafts, { recursive: true });
      await page.getByRole("button", { name: "Start thread" }).click();
      await page.getByText("An attachment is missing; attach the file again").waitFor();
      assert.match(page.url(), /#\/project\/demo\/new$/);
      assert.equal(await text(), shown);
      await page.getByTitle("Remove notes.txt").click();

      await page.locator('input[type="file"]').setInputFiles([TEXT]);
      await page.locator(".strip .progress").waitFor({ state: "detached" });
      await page.getByRole("button", { name: "Start thread" }).click();
      await page.waitForURL(/#\/thread\//);
      const threadId = page.url().split("/").pop()!;

      // The new thread's own flow takes over: its workspace is prepared, then the agent replies.
      await page.getByTitle("Download notes.txt").waitFor();
      await page.getByText("Reply finished.").waitFor();
      const gap = await page.evaluate(() => {
        const transcript = document.querySelector<HTMLElement>(".transcript")!;
        return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
      });
      assert.ok(gap < 2, `transcript ${gap}px above the bottom after the reply`);
      assert.deepEqual(await readdir(drafts), []);
      const [record] = (await readdir(join(server.home, "attachments", threadId))).filter((name) => name.endsWith(".json"));
      assert.ok(existsSync(join(server.home, "attachments", threadId, record!.replace(".json", ""), "notes.txt")));
      await page.locator("header .chip", { hasText: "borkcode/" }).waitFor();

      // The draft is gone, and the next new thread starts as a Thread in a worktree with Codex.
      assert.equal(await savedDraft(page, (text) => text === undefined), undefined);
      await page.evaluate(() => (location.hash = "#/project/demo/new"));
      await composer.waitFor();
      assert.equal(await (engine === "chromium" ? composer.textContent() : composer.inputValue()), "");
      assert.equal(await page.locator(".strip").count(), 0);
      assert.deepEqual(await picksShown(page, engine), { agent: "Codex", ...NEW });
      await close();
    });

    test("New thread buttons focus the composer at the end of the draft; a reload does not", async () => {
      const { page, close } = await open(browser, engine, server, EXISTING);
      const composer = page.locator("[data-composer]");
      const focused = () => composer.evaluate((element) => document.activeElement === element);
      // Whether the composer had focus by the end of each click's dispatch, i.e. within the tap,
      // which is when iOS still opens the keyboard for it.
      await page.evaluate(() => {
        const w = window as unknown as { focusedInClick: boolean[] };
        w.focusedInClick = [];
        addEventListener("click", () => w.focusedInClick.push(document.activeElement?.hasAttribute("data-composer") ?? false));
      });
      const inClick = () => page.evaluate(() => (window as unknown as { focusedInClick: boolean[] }).focusedInClick.at(-1));
      const plus = async () => {
        if (engine === "webkit") await page.getByRole("button", { name: "Open navigation" }).click();
        await page.getByTitle("New thread in demo").click();
      };

      await plus();
      await page.waitForURL(/#\/project\/demo\/new$/);
      // Focused by the tap itself, so on a phone the drawer is already gone and iOS may show the keyboard.
      assert.ok(await focused(), "the composer is focused after +");
      assert.equal(await inClick(), true, "focused within the tap");
      if (engine === "webkit") assert.equal(await page.locator(".sidebar.open").count(), 0, "the drawer closed");
      await page.keyboard.type("Start here");

      await page.evaluate(() => (location.hash = "#/project/demo"));
      await page.getByRole("button", { name: "New thread", exact: true }).click();
      assert.ok(await focused(), "the composer is focused after the project page's button");
      assert.equal(await inClick(), true, "focused within the tap");
      await page.keyboard.type(", then go on");
      assert.equal(await savedDraft(page, (text) => !!text?.endsWith("go on")), "Start here, then go on");

      // Only the buttons focus: a reload, or coming back with the back button, leaves focus alone.
      await page.reload();
      await composer.waitFor();
      assert.equal(await focused(), false, "a reload does not focus the composer");
      await page.goBack();
      await page.goForward();
      await composer.waitFor();
      assert.equal(await focused(), false, "history navigation does not focus the composer");

      await composer.fill("");
      assert.equal(await savedDraft(page, (text) => text === undefined), undefined);
      await close();
    });
  });
}
