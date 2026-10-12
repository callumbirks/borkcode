// Auto-scroll: a transcript at its bottom follows whatever arrives, and one the user scrolled up
// stays put. Desktop Chromium and an iPhone-sized touch WebKit, against a seeded server.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Browser, Page } from "playwright";
import { launch, missingWebKitLibraries, open, startServer, type Engine, type Item, type Server, type Session } from "./harness.ts";

const LONG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SEND = "33333333-3333-4333-8333-333333333333";
const SEND_UP = "44444444-4444-4444-8444-444444444444";
const TALL_CARD = "55555555-5555-4555-8555-555555555555";
const GROWING_CARD = "66666666-6666-4666-8666-666666666666";
const MOVE = "77777777-7777-4777-8777-777777777777";
const FAR_CARD = "88888888-8888-4888-8888-888888888888";

const paragraph = "A paragraph with enough words to wrap a few times on a phone and once on a desktop. ";
const tools = (prefix: string, count: number): Item[] =>
  Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, kind: "tool", name: "shell", summary: `step ${i}`, output: `output of step ${i}\n`.repeat(4), status: "done" }));

function conversation(prefix: string, turns: number): Item[] {
  return Array.from({ length: turns }, (_, i): Item[] => [
    { id: `${prefix}-u${i}`, kind: "user", text: `Question ${i}` },
    ...(i % 5 === 0 ? tools(`${prefix}-t${i}`, 6) : []),
    { id: `${prefix}-a${i}`, kind: "assistant", text: `Answer ${i}\n\n` + (paragraph.repeat(3) + "\n\n").repeat((i % 4) + 1) },
  ]).flat();
}

const threads = [
  {
    id: LONG,
    title: "Long thread",
    items: [
      ...conversation("long", 80),
      { id: TALL_CARD, kind: "visualization", title: "Tall card", updatedAt: 1 },
      { id: "long-from", kind: "user", fromThreadId: OTHER, text: Array.from({ length: 14 }, (_, i) => `Report line ${i}`).join("\n") },
      ...tools("long-last", 8),
      { id: "long-end", kind: "assistant", text: "See `app/README.md` for details. LAST-LONG" },
    ] satisfies Item[],
  },
  { id: OTHER, title: "Other thread", items: conversation("other", 3) },
  {
    id: MOVE,
    title: "Replaced card",
    items: [
      ...conversation("before", 30),
      { id: FAR_CARD, kind: "visualization", title: "Far card", updatedAt: 1 },
      ...conversation("after", 30),
      { id: "move-end", kind: "assistant", text: "LAST-MOVE" },
    ] satisfies Item[],
  },
  { id: SEND, title: "Send thread", items: [...conversation("send", 20), { id: "send-done", kind: "assistant", text: "Agent response done." }] },
  { id: SEND_UP, title: "Send while scrolled up", items: [...conversation("up", 20), { id: "up-done", kind: "assistant", text: "Agent response done." }] },
] satisfies { id: string; title: string; items: Item[] }[];

const visualizations = {
  [MOVE]: { [FAR_CARD]: `<div style="height:520px;background:#642">Far card</div>` },
  [LONG]: {
    [TALL_CARD]: `<div style="height:760px;background:#246">Tall card</div>`,
    // Grows after it first reports its height, as a chart does once its data loads.
    [GROWING_CARD]: `<div id="box" style="height:150px;background:#462">Growing card</div><script>setTimeout(() => (box.style.height = "640px"), 300)</script>`,
  },
};

const settle = (page: Page) =>
  page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done)))));

const metrics = (page: Page) =>
  page.evaluate(() => {
    const transcript = document.querySelector<HTMLElement>(".transcript")!;
    return { top: transcript.scrollTop, gap: transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight };
  });

/** Wheel and key scrolling animate; waits until the transcript has not moved for a few frames. */
const still = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) => {
        const transcript = document.querySelector<HTMLElement>(".transcript")!;
        let last = -1;
        let same = 0;
        const tick = () => {
          same = transcript.scrollTop === last ? same + 1 : 0;
          last = transcript.scrollTop;
          if (same >= 5) done();
          else requestAnimationFrame(tick);
        };
        tick();
      }),
  );

async function assertFollowing(page: Page, what: string) {
  await settle(page);
  const { gap } = await metrics(page);
  assert.ok(gap < 2, `${what}: ${gap}px above the bottom`);
}

async function assertStayed(page: Page, top: number, what: string) {
  await settle(page);
  const now = await metrics(page);
  assert.ok(Math.abs(now.top - top) < 2 && now.gap > 200, `${what}: moved from ${top} to ${now.top} (${now.gap}px above the bottom)`);
}

let streams = 0;
/** Streams an assistant reply over the socket; `between` runs after each delta lands. */
async function stream(session: Session, chunks = 6, between?: (index: number) => Promise<void>) {
  const itemId = `stream-${++streams}`;
  const send = (event: object) => session.socket().send(JSON.stringify({ event }));
  const threadId = await session.page.evaluate(() => location.hash.split("/").pop()!);
  send({ type: "item.upserted", threadId, item: { id: itemId, kind: "assistant", text: `Streaming ${itemId}` } });
  for (let i = 0; i < chunks; i++) {
    send({ type: "item.delta", threadId, itemId, text: `\n\n${paragraph.repeat(2)} [${itemId} chunk ${i}]` });
    await session.page.getByText(`[${itemId} chunk ${i}]`).waitFor();
    await between?.(i);
  }
}

function upsert(session: Session, threadId: string, item: Item) {
  session.socket().send(JSON.stringify({ event: { type: "item.upserted", threadId, item } }));
}

/** Touch scrolling as WebKit sees it: touch events around scroll movement, frame by frame. */
async function touchScroll(page: Page, by: number, { momentum = 0 } = {}) {
  await page.evaluate(
    async ({ by, momentum }) => {
      const transcript = document.querySelector<HTMLElement>(".transcript")!;
      const frame = () => new Promise((done) => requestAnimationFrame(done));
      const touch = (type: string) => transcript.dispatchEvent(new Event(type, { bubbles: true }));
      touch("touchstart");
      for (let i = 0; i < 5; i++) {
        transcript.scrollTop += by / 5;
        await frame();
      }
      touch("touchend");
      // A flick keeps scrolling after the finger lifts.
      for (let i = 0; i < momentum; i++) {
        transcript.scrollTop += by / 10;
        await frame();
      }
      await frame();
    },
    { by, momentum },
  );
}

async function scrollUp(page: Page, engine: Engine) {
  if (engine === "chromium") {
    await page.locator(".transcript").hover();
    await page.mouse.wheel(0, -900);
  } else {
    await touchScroll(page, -900);
  }
  await still(page);
}

/** A click (or tap) in the visible middle of the transcript. */
async function clickTranscript(page: Page, engine: Engine) {
  const box = (await page.locator(".transcript").boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  if (engine === "webkit") await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

async function waitForCard(page: Page, id: string, min: number) {
  await page.waitForFunction(
    ({ id, min }) => {
      const frame = document.querySelector<HTMLIFrameElement>(`iframe[src*="${id}"]`);
      return !!frame && frame.getBoundingClientRect().height >= min;
    },
    { id, min },
  );
}

async function sendMessage(page: Page, engine: Engine, text: string) {
  const composer = page.locator("[data-composer]");
  await composer.click();
  if (engine === "chromium") {
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
  } else {
    await composer.fill(text);
    await page.getByRole("button", { name: "Send", exact: true }).click();
  }
}

const engines = (process.env.E2E_BROWSERS ?? "chromium,webkit").split(",") as Engine[];
const webkitMissing = engines.includes("webkit") ? await missingWebKitLibraries() : null;
if (webkitMissing) console.warn(webkitMissing);

for (const engine of engines) {
  describe(`auto-scroll (${engine})`, { skip: (engine === "webkit" && webkitMissing) || false }, () => {
    let server: Server;
    let browser: Browser;
    const sessions: Session[] = [];
    const visit = async (threadId: string) => {
      const session = await open(browser, engine, server, threadId);
      sessions.push(session);
      return session;
    };
    const openLong = async () => {
      const session = await visit(LONG);
      await session.page.getByText("LAST-LONG").waitFor();
      await waitForCard(session.page, TALL_CARD, 700);
      return session;
    };

    before(async () => {
      server = await startServer(threads, visualizations);
      browser = await launch(engine);
    });
    after(async () => {
      await browser?.close();
      await server?.stop();
    });
    const done = async () => {
      for (const session of sessions.splice(0)) await session.close();
    };

    test("opening a long thread lands at the bottom, after tall cards size themselves", async () => {
      const { page } = await openLong();
      await assertFollowing(page, "opened");
      await done();
    });

    test("a streaming reply is followed", async () => {
      const session = await openLong();
      await stream(session, 8, () => assertFollowing(session.page, "mid-stream"));
      await done();
    });

    test("new items are followed", async () => {
      const session = await openLong();
      upsert(session, LONG, { id: "new-user", kind: "user", text: "A new message" });
      for (const item of tools("new-tools", 3)) upsert(session, LONG, item);
      upsert(session, LONG, { id: "new-answer", kind: "assistant", text: (paragraph.repeat(4) + "\n\n").repeat(3) + "NEW-ANSWER" });
      await session.page.getByText("NEW-ANSWER").waitFor();
      await assertFollowing(session.page, "after new items");
      await done();
    });

    test("an image loading late is followed", async () => {
      const session = await openLong();
      const { page } = session;
      let release!: () => void;
      const held = new Promise<void>((done) => (release = done));
      await page.route("**/files?root=workspace&path=app%2Ftall.png", async (route) => {
        await held;
        await route.continue();
      });
      upsert(session, LONG, { id: "image-answer", kind: "assistant", text: `Here it is:\n\n![tall](/api/threads/${LONG}/files?root=workspace&path=app%2Ftall.png)\n\nIMAGE-ANSWER` });
      await page.getByText("IMAGE-ANSWER").waitFor();
      await assertFollowing(page, "before the image loads");
      release();
      await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('img[alt="tall"]')].some((img) => img.complete && img.naturalHeight > 0));
      await assertFollowing(page, "after the image loads");
      await done();
    });

    test("a visualization card growing is followed", async () => {
      const session = await openLong();
      upsert(session, LONG, { id: GROWING_CARD, kind: "visualization", title: "Growing card", updatedAt: 1 });
      await waitForCard(session.page, GROWING_CARD, 600);
      await assertFollowing(session.page, "after the card grew");
      await done();
    });

    test("a replaced card far above moves to the bottom and is followed without a jump", async () => {
      const session = await visit(MOVE);
      const { page } = session;
      await page.getByText("LAST-MOVE").waitFor();
      await assertFollowing(page, "opened");
      // The view as painted in each frame from the move until the card has loaded and settled.
      // A frame's rAF reads layout before that frame's ResizeObserver follows it, so an observer
      // made after the transcript's (they run in creation order) corrects the frame's sample.
      await page.evaluate(() => {
        const transcript = document.querySelector<HTMLElement>(".transcript")!;
        const gap = () => transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
        const gaps: number[] = [];
        (window as unknown as { gaps: number[] }).gaps = gaps;
        new ResizeObserver(() => gaps.length && (gaps[gaps.length - 1] = gap())).observe(transcript.firstElementChild!);
        const tick = () => {
          gaps.push(gap());
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      session.socket().send(JSON.stringify({ event: { type: "item.upserted", threadId: MOVE, item: { id: FAR_CARD, kind: "visualization", title: "Far card v2", updatedAt: 2 }, toEnd: true } }));
      await page.getByText("Far card v2").waitFor();
      await waitForCard(page, FAR_CARD, 500);
      await settle(page);
      const last = await page.evaluate(() => {
        const column = document.querySelector(".transcript .column")!;
        return !!column.lastElementChild?.querySelector("iframe");
      });
      assert.ok(last, "the card is the last item");
      assert.equal(await page.locator("iframe[src*='" + FAR_CARD + "']").count(), 1, "one card");
      const gaps = await page.evaluate(() => (window as unknown as { gaps: number[] }).gaps);
      assert.ok(Math.max(...gaps) < 2, `jumped up to ${Math.max(...gaps)}px above the bottom: ${gaps.filter((gap) => gap >= 2).join(", ")}`);
      await assertFollowing(page, "after the move");
      await stream(session, 2);
      await assertFollowing(page, "still pinned after the move");
      await done();
    });

    test("expanding a collapsed message is followed", async () => {
      const { page } = await openLong();
      const message = page.locator(".user.agent.collapsible");
      if (engine === "webkit") await message.tap();
      else await message.click();
      await page.locator('.user.agent[aria-expanded="true"]').waitFor();
      await assertFollowing(page, "after expanding");
      await done();
    });

    test("opening a lazy steps group is followed", async () => {
      const { page } = await openLong();
      const summary = page.locator("details.group > summary").last();
      if (engine === "webkit") await summary.tap();
      else await summary.click();
      await page.locator("details.group").last().locator(".steps").waitFor();
      await assertFollowing(page, "after opening the group");
      await done();
    });

    test("sending after an agent response follows the message and then the reply", async () => {
      const { page } = await visit(SEND);
      await page.getByText("Agent response done.").waitFor();
      await assertFollowing(page, "opened");
      await sendMessage(page, engine, "Hello after the response");
      const sent = page.locator(".transcript").getByText("Hello after the response");
      await sent.waitFor();
      await assertFollowing(page, "after sending");
      await page.getByText("Reply finished.").waitFor();
      await assertFollowing(page, "after the reply");
      // Again after a reply that streamed in live and ended its turn.
      await page.getByText("Working…").waitFor({ state: "detached" });
      await sendMessage(page, engine, "Second message");
      await page.locator(".transcript").getByText("Second message").waitFor();
      await assertFollowing(page, "after sending again");
      await page.getByText("Reply finished.").nth(1).waitFor();
      await assertFollowing(page, "after the second reply");
      await done();
    });

    test("sending while scrolled up jumps to the bottom and follows the reply", async () => {
      const { page } = await visit(SEND_UP);
      await page.getByText("Agent response done.").waitFor();
      await settle(page);
      await scrollUp(page, engine);
      assert.ok((await metrics(page)).gap > 200, "scrolled up first");
      await sendMessage(page, engine, "Hello from up the thread");
      await page.locator(".transcript").getByText("Hello from up the thread").waitFor();
      await assertFollowing(page, "after sending");
      await page.getByText("Reply finished.").waitFor();
      await assertFollowing(page, "after the reply");
      await done();
    });

    const stopsFollowing = (name: string, engines: Engine[], scroll: (page: Page) => Promise<void>) => {
      test(`scrolling up mid-stream stays put: ${name}`, { skip: !engines.includes(engine) && `${name} is ${engines.join("/")} only` }, async () => {
        const session = await openLong();
        const { page } = session;
        let top = -1;
        await stream(session, 8, async (index) => {
          if (index === 1) {
            await scroll(page);
            await still(page);
            top = (await metrics(page)).top;
          } else if (index > 1) {
            await assertStayed(page, top, `after chunk ${index}`);
          }
        });
        await done();
      });
    };
    stopsFollowing("mouse wheel", ["chromium", "webkit"], async (page) => {
      await page.locator(".transcript").hover();
      await page.mouse.wheel(0, -600);
    });
    stopsFollowing("dragging the scrollbar", ["chromium"], async (page) => {
      const box = (await page.locator(".transcript").boundingBox())!;
      const x = box.x + box.width - 6;
      // The thumb sits just above the down-arrow button at the bottom of the track.
      await page.mouse.move(x, box.y + box.height - 22);
      await page.mouse.down();
      for (let i = 1; i <= 5; i++) {
        await page.mouse.move(x, box.y + box.height - 22 - i * 20);
        await settle(page);
      }
      await page.mouse.up();
    });
    stopsFollowing("PageUp", ["chromium", "webkit"], async (page) => {
      await clickTranscript(page, "chromium");
      await page.keyboard.press("PageUp");
      await page.waitForFunction(() => {
        const t = document.querySelector<HTMLElement>(".transcript")!;
        return t.scrollHeight - t.scrollTop - t.clientHeight > 200;
      });
    });
    stopsFollowing("touch drag", ["webkit"], (page) => touchScroll(page, -600));
    stopsFollowing("a flick with momentum", ["webkit"], (page) => touchScroll(page, -60, { momentum: 10 }));

    test("scrolling back to the bottom follows again", async () => {
      const session = await openLong();
      const { page } = session;
      await scrollUp(page, engine);
      if (engine === "chromium") await page.mouse.wheel(0, 100_000);
      else await touchScroll(page, 100_000);
      await still(page);
      await stream(session, 4);
      await assertFollowing(page, "after returning");
      await done();
    });

    test("a tap on the transcript keeps it pinned", async () => {
      const session = await openLong();
      const { page } = session;
      await clickTranscript(page, engine);
      await stream(session, 4);
      await assertFollowing(page, "after a tap");
      await done();
    });

    test("the composer growing and shrinking keeps it pinned", async () => {
      const { page } = await openLong();
      const composer = page.locator("[data-composer]");
      await composer.click();
      if (engine === "chromium") {
        for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+Enter");
      } else {
        await composer.fill("one\ntwo\nthree\nfour\nfive\nsix");
      }
      await assertFollowing(page, "composer grown");
      if (engine === "chromium") {
        for (let i = 0; i < 6; i++) await page.keyboard.press("Backspace");
      } else {
        await composer.fill("");
      }
      await assertFollowing(page, "composer shrunk");
      await done();
    });

    test("opening and closing the keyboard keeps it pinned", { skip: engine !== "webkit" && "keyboard is simulated on WebKit" }, async () => {
      const session = await openLong();
      const { page } = session;
      await page.locator("[data-composer]").focus();
      await page.evaluate(() => (window as unknown as { __keyboard: (height?: number) => void }).__keyboard(480));
      await assertFollowing(page, "keyboard open");
      await stream(session, 3);
      await assertFollowing(page, "streaming with the keyboard open");
      await page.evaluate(() => (window as unknown as { __keyboard: (height?: number) => void }).__keyboard());
      await assertFollowing(page, "keyboard closed");
      await done();
    });

    test("switching threads and back lands at the bottom and follows", async () => {
      const session = await openLong();
      const { page } = session;
      await scrollUp(page, engine);
      await page.evaluate((id) => (location.hash = `#/thread/${id}`), OTHER);
      await page.getByText("Answer 2").waitFor();
      await assertFollowing(page, "the other thread");
      await page.evaluate((id) => (location.hash = `#/thread/${id}`), LONG);
      await page.getByText("LAST-LONG").waitFor();
      await waitForCard(page, TALL_CARD, 700);
      await assertFollowing(page, "back on the long thread");
      await stream(session, 3);
      await assertFollowing(page, "streaming after switching back");
      await done();
    });

    test("opening and closing the preview panel keeps it pinned", async () => {
      const { page } = await openLong();
      await page.locator(".transcript a", { hasText: "app/README.md" }).last().click();
      await page.getByText("Previewed from the transcript.").waitFor();
      if (engine === "chromium") await assertFollowing(page, "preview open");
      await page.getByTitle("Close (Esc)").click();
      await page.getByText("Previewed from the transcript.").waitFor({ state: "detached" });
      await assertFollowing(page, "preview closed");
      await done();
    });

    test("resizing the window keeps it pinned", async () => {
      const { page } = await openLong();
      const size = page.viewportSize()!;
      await page.setViewportSize({ width: Math.round(size.width * 0.8), height: size.height - 100 });
      await assertFollowing(page, "narrower and shorter");
      await page.setViewportSize(size);
      await assertFollowing(page, "back to full size");
      await done();
    });
  });
}
