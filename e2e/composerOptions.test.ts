// The composer's model and option controls: no "Default" model or effort anywhere, choices saved
// as null before that shown by name, and the fast mode, access, role and workspace icon toggles,
// which persist and fit on one line on a 360px phone. Claude's model list is stubbed from a real
// `supportedModels()` sample through the server's own filter; Codex is the fake CLI.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Browser, Locator, Page } from "playwright";
import { claudeModelOptions } from "../server/src/providers/claude.ts";
import { launch, missingWebKitLibraries, open, startServer, type Engine, type Server } from "./harness.ts";

const THREAD = "88888888-8888-4888-8888-888888888888";
const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
const claude = claudeModelOptions([
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5", supportsEffort: true, supportedEffortLevels: [...efforts], supportsFastMode: true },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "", supportsEffort: true, supportedEffortLevels: [...efforts], supportsFastMode: true },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "", supportsEffort: true, supportedEffortLevels: [...efforts] },
]);
// Saved before models were always named: the title model and a rule on defaults, the rule's
// parent on Claude's old "default".
const settings = {
  titleModel: { provider: "claude", model: null, effort: null },
  childModelRules: [{ when: { provider: "claude", model: "default", effort: null }, use: { provider: "codex", model: null, effort: "high" } }],
};
// New-thread preferences from before fast mode, on Claude's defaults.
const oldPreferences = JSON.stringify({ provider: "claude", providers: { claude: { model: null, effort: null, accessMode: "ask" } } });

const engines = (process.env.E2E_BROWSERS ?? "chromium,webkit").split(",") as Engine[];
const webkitMissing = engines.includes("webkit") ? await missingWebKitLibraries() : null;
if (webkitMissing) console.warn(webkitMissing);

/** Every option of every select on the page, sheets included, so nothing offers "Default". */
const optionTexts = (page: Page) => page.locator("select option").allTextContents();

const selected = (scope: Locator, label: string) =>
  scope.locator(`select[aria-label="${label}"]`).evaluate((select: HTMLSelectElement) => select.selectedOptions[0]!.text);

/** The model and effort the composer shows: the row's pickers on desktop, the sheet on a phone. */
async function modelShown(page: Page, engine: Engine) {
  const scope = engine === "chromium" ? page.locator(".desktop-options") : page.locator("dialog[open]");
  if (engine === "webkit") await page.locator(".phone-options .summary").click();
  // Enabled once the provider's list has arrived.
  await scope.locator('select[aria-label="Model"]:enabled').waitFor();
  const shown = `${await selected(scope, "Model")} · ${await selected(scope, "Effort")}`;
  if (engine === "webkit") await scope.getByRole("button", { name: "Done" }).click();
  return shown;
}

async function pickModel(page: Page, engine: Engine, model: string) {
  if (engine === "chromium") return page.locator('.desktop-options select[aria-label="Model"]').selectOption(model);
  await page.locator(".phone-options .summary").click();
  await page.locator('dialog[open] select[aria-label="Model"]').selectOption(model);
  await page.locator("dialog[open]").getByRole("button", { name: "Done" }).click();
}

/** The visible toggle whose label starts with `name`, from the desktop row or the phone row. */
const toggle = (page: Page, name: string) => page.locator(`button[aria-label^="${name}: "]:visible`);
const fastIcon = (page: Page) => toggle(page, "Fast mode").locator("svg").getAttribute("fill");

for (const engine of engines) {
  describe(`composer options (${engine})`, { skip: (engine === "webkit" && webkitMissing) || false }, () => {
    let server: Server;
    let browser: Browser;
    before(async () => {
      server = await startServer([{ id: THREAD, title: "On old defaults", items: [{ id: "a", kind: "assistant", text: "Hello." }] }], {}, settings);
      browser = await launch(engine);
    });
    after(async () => {
      await browser?.close();
      await server?.stop();
    });

    test("no Default entries, and choices saved as defaults show by name", async () => {
      const { page, close } = await open(browser, engine, server, THREAD, { models: { claude } });
      // The seeded Codex thread has a null model and effort.
      assert.equal(await modelShown(page, engine), "Fake · medium");
      assert.deepEqual((await optionTexts(page)).filter((text) => /default/i.test(text)), []);

      await page.evaluate((saved) => localStorage.setItem("borkcode.threadDefaults", saved), oldPreferences);
      await page.evaluate(() => (location.hash = "#/project/demo/new"));
      await page.getByText("What should the agent do?", { exact: false }).first().waitFor();
      assert.equal(await modelShown(page, engine), "Opus 5.5 · high");
      assert.deepEqual((await optionTexts(page)).filter((text) => /default/i.test(text)), []);
      // Fast mode, saved nowhere yet, starts off for a model that offers it.
      assert.equal(await toggle(page, "Fast mode").getAttribute("aria-label"), "Fast mode: off");

      await page.evaluate(() => (location.hash = "#/settings"));
      const titles = page.locator("form", { hasText: "Thread titles" });
      await titles.locator('select[aria-label="Model"]:enabled').waitFor();
      assert.equal(await selected(titles, "Model"), "Opus 5.5");
      assert.equal(await selected(titles, "Effort"), "high");
      const rule = page.locator(".rule").first();
      assert.equal(await selected(rule.locator(".row").first(), "Model"), "Opus 5.5");
      assert.equal(await selected(rule.locator(".row").first(), "Effort"), "Any effort");
      assert.equal(await selected(rule.locator(".row").nth(1), "Model"), "Fake");
      assert.equal(await selected(rule.locator(".row").nth(1), "Effort"), "high");
      // A rule from before fast mode inherits it; On is saved to settings.json and shown again.
      const fast = rule.locator(".row").nth(1).getByLabel("Fast mode");
      assert.equal(await fast.inputValue(), "inherit");
      await fast.selectOption("on");
      await page.locator("form", { hasText: "Add rule" }).getByRole("button", { name: "Save" }).click();
      await page.locator("form", { hasText: "Add rule" }).getByText("Saved").waitFor();
      const stored = JSON.parse(await readFile(join(server.home, "settings.json"), "utf8"));
      assert.equal(stored.childModelRules[0].use.fastMode, "on");
      await page.reload();
      await fast.waitFor();
      assert.equal(await fast.inputValue(), "on");
      assert.deepEqual((await optionTexts(page)).filter((text) => /default/i.test(text)), []);
      await close();
    });

    test("fast mode and access toggle, reach the agent and persist", async () => {
      const { page, close } = await open(browser, engine, server, THREAD);
      const fast = toggle(page, "Fast mode");
      assert.equal(await fast.getAttribute("aria-pressed"), "false");
      assert.equal(await fastIcon(page), "none");
      await fast.click();
      assert.equal(await fast.getAttribute("aria-label"), "Fast mode: on");
      assert.equal(await fast.getAttribute("aria-pressed"), "true");
      assert.equal(await fastIcon(page), "currentColor");

      // The seeded thread has full access.
      const access = toggle(page, "Access");
      assert.equal(await access.getAttribute("aria-label"), "Access: full access");
      await access.click();
      assert.equal(await access.getAttribute("aria-label"), "Access: ask first");
      assert.equal(await access.getAttribute("aria-pressed"), "false");

      // Hidden for a model without fast mode, and still on when back on one with it.
      await pickModel(page, engine, "fake-steady");
      await fast.waitFor({ state: "detached" });
      await pickModel(page, engine, "fake");
      assert.equal(await fast.getAttribute("aria-pressed"), "true");

      const composer = page.locator("[data-composer]");
      await composer.click();
      await page.keyboard.type("go fast");
      await page.getByRole("button", { name: "Send" }).click();
      await page.getByText("Service tier: priority.").waitFor();

      await page.reload();
      await composer.waitFor();
      assert.equal(await toggle(page, "Fast mode").getAttribute("aria-pressed"), "true");
      assert.equal(await toggle(page, "Access").getAttribute("aria-label"), "Access: ask first");
      await toggle(page, "Fast mode").click();
      await composer.click();
      await page.keyboard.type("slow down");
      await page.getByRole("button", { name: "Send" }).click();
      await page.getByText("Service tier: default.").waitFor();
      await close();
    });
  });
}

describe("composer options on desktop and a 360px phone (chromium)", { skip: !engines.includes("chromium") }, () => {
  let server: Server;
  let browser: Browser;
  before(async () => {
    server = await startServer([{ id: THREAD, title: "Narrow", items: [{ id: "a", kind: "assistant", text: "Hello." }] }]);
    browser = await launch("chromium");
  });
  after(async () => {
    await browser?.close();
    await server?.stop();
  });

  test("the new thread's role and workspace toggles, and fast mode remembered per provider", async () => {
    const { page, close } = await open(browser, "chromium", server, THREAD, { hash: "#/project/demo/new", models: { claude } });
    const row = page.locator(".desktop-options");
    await row.locator('select[aria-label="Agent"]').selectOption("codex");
    const role = toggle(page, "Role");
    const workspace = toggle(page, "Workspace");
    assert.equal(await role.getAttribute("aria-label"), "Role: thread");
    await workspace.click();
    assert.equal(await workspace.getAttribute("aria-label"), "Workspace: main checkouts");
    assert.equal(await workspace.getAttribute("aria-pressed"), "true");
    // Captains always get their own worktree.
    await role.click();
    assert.equal(await role.getAttribute("aria-label"), "Role: captain");
    assert.equal(await role.getAttribute("aria-pressed"), "true");
    assert.equal(await workspace.getAttribute("aria-label"), "Workspace: new worktree");
    assert.ok(await workspace.isDisabled());
    await role.click();
    assert.equal(await workspace.getAttribute("aria-label"), "Workspace: main checkouts");

    await toggle(page, "Fast mode").click();
    await page.locator("[data-composer]").click();
    await page.keyboard.type("in the main checkouts");
    await page.getByRole("button", { name: "Start thread" }).click();
    await page.waitForURL(/#\/thread\//);
    await page.getByText("Service tier: priority.").waitFor();
    // A main-checkout thread has no branch chip.
    assert.equal(await page.locator("header .chip", { hasText: "borkcode/" }).count(), 0);

    await page.evaluate(() => (location.hash = "#/project/demo/new"));
    await page.locator("[data-composer]").waitFor();
    assert.equal(await selected(row, "Agent"), "Codex");
    assert.equal(await toggle(page, "Fast mode").getAttribute("aria-pressed"), "true");
    assert.equal(await role.getAttribute("aria-label"), "Role: thread");
    assert.equal(await workspace.getAttribute("aria-label"), "Workspace: new worktree");
    // Claude's preferences are its own: fast mode off.
    await row.locator('select[aria-label="Agent"]').selectOption("claude");
    assert.equal(await toggle(page, "Fast mode").getAttribute("aria-pressed"), "false");
    await close();
  });

  test("the controls row fits on one line at 360px", async () => {
    const context = { viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true };
    for (const hash of [`#/thread/${THREAD}`, "#/project/demo/new"]) {
      const { page, close } = await open(browser, "chromium", server, THREAD, { hash, context, models: { claude } });
      await toggle(page, "Fast mode").waitFor();
      const boxes = await page.locator(".composer .actions").evaluate((actions) => {
        const visible = [...actions.querySelectorAll("button")].filter((button) => button.getClientRects().length > 0);
        return {
          row: actions.getBoundingClientRect().toJSON() as DOMRect,
          buttons: visible.map((button) => ({ label: button.getAttribute("aria-label") ?? button.title, ...(button.getBoundingClientRect().toJSON() as DOMRect) })),
        };
      });
      const labels = boxes.buttons.map((button) => button.label.split(":")[0]);
      for (const name of ["Attach files (or paste or drop them)", "Composer options", "Fast mode", "Access"]) {
        assert.ok(labels.includes(name), `${hash}: ${name} shown in ${labels.join(", ")}`);
      }
      for (const button of boxes.buttons) {
        assert.ok(button.left >= boxes.row.left - 0.5 && button.right <= boxes.row.right + 0.5, `${hash}: ${button.label} inside the row`);
        assert.ok(Math.abs(button.top - boxes.buttons[0]!.top) < 4, `${hash}: ${button.label} on the same line`);
      }
      await close();
    }
  });
});
