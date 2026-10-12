// File attachments: any file goes through the paperclip or a drop, shows as a chip while it uploads,
// and comes back from the transcript as a download, never rendered. Desktop Chromium, an
// iPhone-sized touch WebKit, and an Android-sized Chromium over a tailnet name on plain HTTP.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { devices, type Browser, type Page } from "playwright";
import { launch, missingWebKitLibraries, open, startServer, type Engine, type Server } from "./harness.ts";

const DESKTOP = "77777777-7777-4777-8777-777777777777";
const PHONE = "88888888-8888-4888-8888-888888888888";
const TAILNET = "99999999-9999-4999-8999-999999999999";
const TAILNET_HOST = "borkbox.tail1234.ts.net";

const PDF = { name: "Q3 report.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% fake pdf for the test\n%%EOF\n") };
const TEXT = { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("plover\n") };
const HTML = `<p id="rendered">rendered</p><script>document.title = "ran"</script>`;

const threads = [DESKTOP, PHONE, TAILNET].map((id, index) => ({
  id,
  title: `Attachments ${index}`,
  items: [{ id: `${id}-a`, kind: "assistant" as const, text: "Send me some files." }],
}));

/** Drops files on the composer the way a browser does, with a DataTransfer holding them. */
async function drop(page: Page, files: { name: string; type: string; text: string }[]) {
  const dataTransfer = await page.evaluateHandle((files) => {
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(new File([file.text], file.name, { type: file.type }));
    return transfer;
  }, files);
  const composer = page.locator(".composer");
  await composer.dispatchEvent("dragover", { dataTransfer });
  await composer.dispatchEvent("drop", { dataTransfer });
}

/** Holds uploads until released, so their in-progress state can be seen. */
async function holdUploads(page: Page) {
  let release!: () => void;
  const held = new Promise<void>((done) => (release = done));
  await page.route("**/attachments", async (route) => {
    await held;
    await route.continue();
  });
  return release;
}

async function downloadFrom(page: Page, title: string) {
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTitle(title).click()]);
  return { name: download.suggestedFilename(), body: await readFile((await download.path())!) };
}

const engines = (process.env.E2E_BROWSERS ?? "chromium,webkit").split(",") as Engine[];
const webkitMissing = engines.includes("webkit") ? await missingWebKitLibraries() : null;
if (webkitMissing) console.warn(webkitMissing);

for (const engine of engines) {
  describe(`attachments (${engine})`, { skip: (engine === "webkit" && webkitMissing) || false }, () => {
    let server: Server;
    let browser: Browser;
    before(async () => {
      server = await startServer(threads);
      browser = await launch(engine);
    });
    after(async () => {
      await browser?.close();
      await server?.stop();
    });

    test("files picked or dropped show as chips, upload, send, and download under their names", async () => {
      const threadId = engine === "chromium" ? DESKTOP : PHONE;
      const { page, close } = await open(browser, engine, server, threadId);
      const release = await holdUploads(page);

      await page.locator('input[type="file"]').setInputFiles([PDF, TEXT]);
      await drop(page, [
        { name: "page.html", type: "text/html", text: HTML },
        { name: "extra.bin", type: "", text: "drop me" },
      ]);
      const chips = page.locator(".strip .chip");
      await assert.doesNotReject(chips.nth(3).waitFor());
      assert.deepEqual(await chips.locator(".name").allTextContents(), ["Q3 report.pdf", "notes.txt", "page.html", "extra.bin"]);
      assert.deepEqual(await chips.locator(".size").allTextContents(), [`${PDF.buffer.length} B`, "7 B", `${HTML.length} B`, "7 B"]);
      assert.equal(await page.locator(".strip .chip .progress").count(), 4, "every chip shows its upload in progress");
      assert.ok(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), "sending waits for uploads");

      await page.getByTitle("Remove extra.bin").click();
      await page.getByText("extra.bin").waitFor({ state: "detached" });
      release();
      await page.locator(".strip .progress").first().waitFor({ state: "detached" });

      const composer = page.locator("[data-composer]");
      await composer.click();
      await composer.fill("Here are the files");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.locator(".strip").waitFor({ state: "detached" });

      // The sent message lists the files as download links, beside its text, and follows the reply.
      const sent = page.locator(".attached .file");
      await sent.nth(2).waitFor();
      assert.deepEqual(await sent.locator(".name").allTextContents(), ["Q3 report.pdf", "notes.txt", "page.html"]);
      await page.getByText("Reply finished.").waitFor();
      const gap = await page.evaluate(() => {
        const transcript = document.querySelector<HTMLElement>(".transcript")!;
        return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
      });
      assert.ok(gap < 2, `transcript ${gap}px above the bottom after the reply`);

      const pdf = await downloadFrom(page, "Download Q3 report.pdf");
      // Playwright's WebKit saves spaces in download names as underscores, whatever the server says.
      assert.deepEqual(pdf, { name: engine === "webkit" ? "Q3_report.pdf" : "Q3 report.pdf", body: PDF.buffer });
      const html = await downloadFrom(page, "Download page.html");
      assert.deepEqual(html, { name: "page.html", body: Buffer.from(HTML) });

      // Opening an uploaded page's URL downloads it rather than running it from borkcode's origin.
      const href = (await page.getByTitle("Download page.html").getAttribute("href"))!;
      const headers = (await page.request.get(new URL(href, server.url).href)).headers();
      assert.equal(headers["content-type"], "application/octet-stream");
      assert.equal(headers["content-disposition"], "attachment; filename*=UTF-8''page.html");
      assert.equal(headers["x-content-type-options"], "nosniff");
      const tab = await page.context().newPage();
      const [download] = await Promise.all([tab.waitForEvent("download"), tab.goto(new URL(href, server.url).href).catch(() => null)]);
      assert.equal(download.suggestedFilename(), "page.html");
      assert.notEqual(await tab.title(), "ran");
      assert.equal(await tab.locator("#rendered").count(), 0);
      await tab.close();

      // The agent reads the file the prompt names, saved under its own name.
      const id = href.split("/").pop()!;
      assert.equal(await readFile(join(server.home, "attachments", threadId, id, "page.html"), "utf8"), HTML);
      await close();
    });
  });
}

describe("attachments over a tailnet name on plain HTTP (Android-sized Chromium)", { skip: !engines.includes("chromium") }, () => {
  let server: Server;
  let browser: Browser;
  before(async () => {
    server = await startServer(threads, {}, undefined, { tailnet: TAILNET_HOST });
    browser = await launch("chromium", [`--host-resolver-rules=MAP ${TAILNET_HOST} 127.0.0.1`]);
  });
  after(async () => {
    await browser?.close();
    await server?.stop();
  });

  test("a phone attaches a file, sends it, and downloads it back", async () => {
    const base = `http://${TAILNET_HOST}:${server.port}`;
    const { page, close } = await open(browser, "chromium", server, TAILNET, { base, context: devices["Pixel 7"] });
    assert.equal(await page.evaluate(() => isSecureContext), false, "plain HTTP on a tailnet name is not a secure context");

    await page.locator('input[type="file"]').setInputFiles([TEXT]);
    await page.locator(".strip .chip").waitFor();
    await page.locator(".strip .progress").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Send", exact: true }).click();

    await page.getByTitle("Download notes.txt").waitFor();
    const text = await downloadFrom(page, "Download notes.txt");
    assert.deepEqual(text, { name: "notes.txt", body: TEXT.buffer });
    await close();
  });
});
