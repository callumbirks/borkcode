import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Item, ServerEvent } from "shared/protocol";
import { Database } from "./db.ts";
import { ProjectStore } from "./projects.ts";
import type { ProviderSession, SessionEvents } from "./providers/types.ts";
import { SettingsStore } from "./settings.ts";
import { ThreadService } from "./threads.ts";

/** A scripted agent: records what it is sent and ends turns when the test says so. */
class FakeAgent implements ProviderSession {
  readonly turns: string[] = [];
  readonly steers: string[] = [];
  /** Whether a message can join the running turn, as when a tool call is in progress. */
  steerable = false;
  readonly #events: SessionEvents;
  #waiting: (() => void)[] = [];

  constructor(events: SessionEvents) {
    this.#events = events;
  }

  async sendTurn(text: string) {
    this.turns.push(text);
    for (const wake of this.#waiting.splice(0)) wake();
  }

  async steer(text: string) {
    if (this.steerable) this.steers.push(text);
    return this.steerable;
  }

  async interrupt() {
    this.#events.turnEnded({ status: "interrupted" });
  }

  close() {}

  /** Resolves with the agent's nth turn once it has been sent. */
  async turn(n: number): Promise<string> {
    while (this.turns.length < n) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    return this.turns[n - 1]!;
  }

  finish(reply: string) {
    this.#events.item({ id: randomUUID(), kind: "assistant", text: reply });
    this.#events.turnEnded({ status: "completed" });
  }
}

const home = await mkdtemp(join(tmpdir(), "borkcode-threads-"));
after(() => rm(home, { recursive: true, force: true }));
const projects = new ProjectStore(home);
await projects.create("demo");
const settings = new SettingsStore(home);

const agents: { cwd: string; agent: FakeAgent }[] = [];
let agentStarted: () => void = () => {};
const eventWaiters: { matches: (event: ServerEvent) => boolean; resolve: () => void }[] = [];

/** Resolves when the server broadcasts an event that matches. */
function broadcastOf(matches: (event: ServerEvent) => boolean): Promise<void> {
  return new Promise((resolve) => eventWaiters.push({ matches, resolve }));
}

function emit(event: ServerEvent) {
  for (const waiter of [...eventWaiters]) {
    if (!waiter.matches(event)) continue;
    eventWaiters.splice(eventWaiters.indexOf(waiter), 1);
    waiter.resolve();
  }
}

const threads = new ThreadService(new Database(":memory:"), projects, settings, emit, "http://test/mcp/", {
  startSession: async (_provider, options) => {
    const agent = new FakeAgent(options.events);
    agents.push({ cwd: options.cwd, agent });
    agentStarted();
    return agent;
  },
  generateTitle: async (text) => `Title ${text.slice(0, 12)}`,
});

/** The agent session of a thread, once its first turn has opened one. */
async function agentOf(threadId: string): Promise<FakeAgent> {
  for (;;) {
    const { workspacePath } = await threads.get(threadId);
    const found = agents.find((entry) => entry.cwd === workspacePath);
    if (found) return found.agent;
    await new Promise<void>((resolve) => (agentStarted = resolve));
  }
}

async function userItems(threadId: string): Promise<Extract<Item, { kind: "user" }>[]> {
  return (await threads.get(threadId)).items.filter((item) => item.kind === "user");
}

async function startThread(text: string) {
  const thread = await threads.create({
    project: "demo",
    text,
    provider: "claude",
    model: null,
    effort: null,
    accessMode: "full",
    isolated: true,
    captain: false,
  });
  return { thread, agent: await agentOf(thread.id) };
}

test("a message to a busy thread joins its turn at the next step, or waits for the turn to end", async () => {
  const { thread, agent } = await startThread("first task");
  assert.equal(await agent.turn(1), "first task");

  await threads.send(thread.id, "while you work", { model: null, effort: null });
  assert.equal((await threads.get(thread.id)).thread.queued, 1);
  agent.finish("done with the first");
  assert.equal(await agent.turn(2), "while you work");

  agent.steerable = true;
  await threads.send(thread.id, "and also this", { model: null, effort: null });
  assert.deepEqual(agent.steers, ["and also this"]);
  const steered = (await userItems(thread.id)).at(-1);
  assert.equal(steered?.text, "and also this");
  assert.equal(steered?.steered, true);
  assert.equal((await threads.get(thread.id)).thread.queued, 0);
  agent.finish("done");
});

test("a watched child reports every turn to its parent, including turns the user started", async () => {
  const { thread: parent, agent: parentAgent } = await startThread("coordinate");
  await parentAgent.turn(1);
  parentAgent.finish("ok");

  const started = await threads.startThread(parent.id, { message: "build it", watch: true, startFrom: "base" });
  assert.match(started, /watching it/);
  const [child] = threads.list().filter((thread) => thread.parentId === parent.id);
  const childAgent = await agentOf(child!.id);
  assert.match(await childAgent.turn(1), /Message from your parent thread[\s\S]*build it/);

  childAgent.finish("Which database should I use?");
  const firstReport = await parentAgent.turn(2);
  assert.match(firstReport, /Report from thread/);
  assert.match(firstReport, /Which database should I use\?/);
  parentAgent.finish("waiting on the user");

  // The user answers the child directly; the outcome still reaches the parent.
  await threads.send(child!.id, "Use SQLite", { model: null, effort: null });
  assert.equal(await childAgent.turn(2), "Use SQLite");
  childAgent.finish("Built it with SQLite.");
  const secondReport = await parentAgent.turn(3);
  assert.match(secondReport, /The user messaged it directly/);
  assert.match(secondReport, /Built it with SQLite\./);
  assert.equal((await userItems(parent.id)).at(-1)?.fromThreadId, child!.id);
  parentAgent.finish("great");
});

test("an unwatched handoff reports nothing until its parent messages it", async () => {
  const { thread: parent, agent: parentAgent } = await startThread("hand off");
  await parentAgent.turn(1);
  parentAgent.finish("ok");

  await threads.startThread(parent.id, { message: "separate work", watch: false, startFrom: "base" });
  const [child] = threads.list().filter((thread) => thread.parentId === parent.id);
  const childAgent = await agentOf(child!.id);
  assert.equal(await childAgent.turn(1), "separate work");
  childAgent.finish("first reply, for the user");

  assert.match(threads.sendToThread(parent.id, child!.id, "status?"), /Sent to/);
  assert.match(await childAgent.turn(2), /status\?/);
  childAgent.finish("second reply, for the parent");
  const reportTurn = await parentAgent.turn(2);
  assert.match(reportTurn, /second reply, for the parent/);
  assert.doesNotMatch(reportTurn, /first reply/);
  assert.equal(parentAgent.turns.length, 2);
  parentAgent.finish("noted");

  assert.throws(() => threads.sendToThread(child!.id, parent.id, "hi"), /not one you started/);
});

test("deliveries between threads pause at the limit and resume when the user steps in", async () => {
  await writeFile(
    settings.path,
    JSON.stringify({ delegation: { wakesPerWindow: 2, windowMinutes: 10, maxAutomaticTurns: 50 } }),
  );
  try {
    const { thread: parent, agent: parentAgent } = await startThread("lead");
    await parentAgent.turn(1);
    parentAgent.finish("ok");
    await threads.startThread(parent.id, { message: "task", watch: true, startFrom: "base" });
    const [child] = threads.list().filter((thread) => thread.parentId === parent.id);
    const childAgent = await agentOf(child!.id);

    // Two reports wake the parent; the third would exceed two wake-ups in the window.
    await childAgent.turn(1);
    childAgent.finish("report one");
    await parentAgent.turn(2);
    parentAgent.finish("ok");
    await threads.send(child!.id, "more", { model: null, effort: null });
    await childAgent.turn(2);
    childAgent.finish("report two");
    await parentAgent.turn(3);
    parentAgent.finish("ok");
    await threads.send(child!.id, "more again", { model: null, effort: null });
    await childAgent.turn(3);
    const paused = broadcastOf(
      (event) => event.type === "thread.updated" && event.thread.id === parent.id && event.thread.paused,
    );
    childAgent.finish("report three");
    await paused;
    const pausedParent = (await threads.get(parent.id)).thread;
    assert.equal(pausedParent.queued, 1);
    assert.equal(parentAgent.turns.length, 3);

    await threads.resume(parent.id);
    assert.match(await parentAgent.turn(4), /report three/);
    assert.equal((await threads.get(parent.id)).thread.paused, false);
  } finally {
    await rm(settings.path, { force: true });
  }
});
