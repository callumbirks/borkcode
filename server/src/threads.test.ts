import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import type { Item, LinkedPullRequest, Question, ServerEvent } from "shared/protocol";
import { AttachmentStore } from "./attachments.ts";
import { Database } from "./db.ts";
import { borkcodeMessage, SERVER_STOPPED_NOTE, userMessage } from "./delegation.ts";
import { ProjectStore } from "./projects.ts";
import type { PullRequestState } from "./pullRequests.ts";
import type { ProviderSession, SessionEvents, TurnAttachment, TurnSettings } from "./providers/types.ts";
import { DEFAULT_SETTINGS, SettingsStore } from "./settings.ts";
import { ThreadService } from "./threads.ts";
import { MAX_VISUALIZATION_BYTES } from "./visualizations.ts";

/** A scripted agent: records what it is sent and ends turns when the test says so. */
class FakeAgent implements ProviderSession {
  readonly turns: string[] = [];
  readonly settings: TurnSettings[] = [];
  readonly steers: string[] = [];
  /** Attachments sent with each turn, then with each steer. */
  readonly attachments: TurnAttachment[][] = [];
  /** Whether a message can join the running turn, as when a tool call is in progress. */
  steerable = false;
  readonly #events: SessionEvents;
  #waiting: (() => void)[] = [];

  constructor(events: SessionEvents) {
    this.#events = events;
  }

  async sendTurn(text: string, settings: TurnSettings, attachments: TurnAttachment[]) {
    this.turns.push(text);
    this.attachments.push(attachments);
    this.settings.push(settings);
    for (const wake of this.#waiting.splice(0)) wake();
  }

  async steer(text: string, attachments: TurnAttachment[]) {
    if (this.steerable) {
      this.steers.push(text);
      this.attachments.push(attachments);
    }
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

  /** An assistant message mid-turn. */
  say(text: string) {
    this.#events.item({ id: randomUUID(), kind: "assistant", text });
  }

  finish(reply: string) {
    this.#events.item({ id: randomUUID(), kind: "assistant", text: reply });
    this.#events.turnEnded({ status: "completed" });
  }

  fail(error: string) {
    this.#events.turnEnded({ status: "failed", error });
  }

  ask(id: string, questions: Question[]) {
    return this.#events.question(id, questions);
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

/** Pull request states as GitHub would report them, and every batch of URLs asked about. */
const remote = new Map<string, PullRequestState>();
const lookups: string[][] = [];

const attachments = new AttachmentStore(home);
/** A 1x1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

/** How often delivery asked for the provider's commands. */
let commandListings = 0;

const fakeDeps = {
  startSession: async (_provider: string, options: { cwd: string; events: SessionEvents }) => {
    const agent = new FakeAgent(options.events);
    agents.push({ cwd: options.cwd, agent });
    agentStarted();
    return agent;
  },
  generateTitle: async (text) => `Title ${text.slice(0, 12)}`,
  pullRequestStates: async (urls) => {
    lookups.push(urls);
    return new Map(urls.flatMap((url) => (remote.has(url) ? [[url, remote.get(url)!] as const] : [])));
  },
  listModels: async (provider) =>
    provider === "claude"
      ? [
          { id: "opus-5-5", name: "Opus 5.5", isDefault: true, efforts: ["medium", "xhigh"], defaultEffort: "xhigh", supportsFastMode: true },
          { id: "haiku", name: "Haiku", isDefault: false, efforts: [], defaultEffort: null, supportsFastMode: false },
        ]
      : [{ id: "gpt-6.1-sol", name: "GPT 6.1 Sol", isDefault: true, efforts: ["low", "high"], defaultEffort: "low", supportsFastMode: false }],
  listCommands: async () => (commandListings++, [
    { name: "compact", description: "Summarize the conversation", argumentHint: "", firstMessage: false },
    { name: "usage", description: "Show usage", argumentHint: "", firstMessage: true },
  ]),
} satisfies ConstructorParameters<typeof ThreadService>[6];
const db = new Database(":memory:");
const threads = new ThreadService(db, projects, settings, emit, "http://test/mcp/", attachments, fakeDeps);

/** The agent session of a thread, once its first turn has opened one. */
async function agentOf(threadId: string, service = threads): Promise<FakeAgent> {
  for (;;) {
    const { workspacePath } = await service.get(threadId);
    const found = agents.find((entry) => entry.cwd === workspacePath);
    if (found) return found.agent;
    await new Promise<void>((resolve) => (agentStarted = resolve));
  }
}

async function userItems(threadId: string): Promise<Extract<Item, { kind: "user" }>[]> {
  return (await threads.get(threadId)).items.filter((item) => item.kind === "user");
}

async function startThread(text: string, fastMode = false) {
  const thread = await threads.create({
    project: "demo",
    text,
    provider: "claude",
    model: null,
    effort: null,
    accessMode: "full",
    fastMode,
    isolated: true,
    captain: false,
  });
  return { thread, agent: await agentOf(thread.id) };
}

test("a message to a busy thread joins its turn at the next step, or waits for the turn to end", async () => {
  const { thread, agent } = await startThread("first task");
  assert.equal(await agent.turn(1), "first task");

  await threads.send(thread.id, "while you work", { model: null, effort: null, accessMode: "full", fastMode: false });
  assert.equal((await threads.get(thread.id)).thread.queued, 1);
  agent.finish("done with the first");
  assert.equal(await agent.turn(2), "while you work");

  agent.steerable = true;
  await threads.send(thread.id, "and also this", { model: null, effort: null, accessMode: "full", fastMode: false });
  assert.deepEqual(agent.steers, ["and also this"]);
  const steered = (await userItems(thread.id)).at(-1);
  assert.equal(steered?.text, "and also this");
  assert.equal(steered?.steered, true);
  assert.equal((await threads.get(thread.id)).thread.queued, 0);
  agent.finish("done");
});

test("a slash command opens a turn of its own, as typed, and is never steered", async () => {
  const picks = { model: null, effort: null, accessMode: "full" as const, fastMode: false };
  const { thread, agent } = await startThread("first task");
  assert.equal(await agent.turn(1), "first task");
  agent.steerable = true;
  await threads.send(thread.id, "/compact keep the API notes", picks);
  await threads.send(thread.id, "then carry on", picks);
  assert.deepEqual(agent.steers, []);
  assert.equal((await threads.get(thread.id)).thread.queued, 2);
  agent.finish("done with the first");
  assert.equal(await agent.turn(2), "/compact keep the API notes");
  agent.finish("Compacted");
  assert.equal(await agent.turn(3), "then carry on");
  agent.finish("done");

  // Messages waiting ahead of a command go together, before it.
  agent.steerable = false;
  await threads.send(thread.id, "next task", picks);
  assert.equal(await agent.turn(4), "next task");
  await threads.send(thread.id, "one more", picks);
  await threads.send(thread.id, "and another", picks);
  await threads.send(thread.id, "/usage", picks);
  agent.finish("done");
  assert.match(await agent.turn(5), /one more[\s\S]*and another/);
  agent.finish("done");
  assert.equal(await agent.turn(6), "/usage");
  agent.finish("done");
});

test("a message starting with a /word the provider does not offer is an ordinary message", async () => {
  const picks = { model: null, effort: null, accessMode: "full" as const, fastMode: false };
  const { thread, agent } = await startThread("first task");
  assert.equal(await agent.turn(1), "first task");
  agent.steerable = true;
  // Plain messages never need the command list, which can mean starting a provider CLI.
  const listings = commandListings;
  await threads.send(thread.id, "check the logs", picks);
  assert.deepEqual(agent.steers, ["check the logs"]);
  assert.equal(commandListings, listings);
  await threads.send(thread.id, "/tmp is full again", picks);
  assert.deepEqual(agent.steers, ["check the logs", "/tmp is full again"]);
  await threads.send(thread.id, "/compact", picks);
  assert.deepEqual(agent.steers, ["check the logs", "/tmp is full again"]);
  assert.equal((await threads.get(thread.id)).thread.queued, 1);
  agent.finish("done");
  assert.equal(await agent.turn(2), "/compact");
  agent.finish("Compacted");
});

test("renaming a thread does not count as activity", async () => {
  const { thread, agent } = await startThread("rename me");
  await agent.turn(1);
  agent.finish("ok");
  const before = (await threads.get(thread.id)).thread.updatedAt;
  assert.equal(threads.rename(thread.id, "A better name").updatedAt, before);
});

test("a changed access mode is saved and applies to the next turn", async () => {
  const { thread, agent } = await startThread("careful now");
  await agent.turn(1);
  agent.finish("ok");
  await threads.send(thread.id, "go ahead", { model: null, effort: null, accessMode: "ask", fastMode: false });
  await agent.turn(2);
  assert.equal(agent.settings[1]?.accessMode, "ask");
  assert.equal((await threads.get(thread.id)).thread.accessMode, "ask");
  agent.finish("done");
});

test("a thread saved on the provider's defaults runs on them by name, and keeps null until changed", async () => {
  const { thread, agent } = await startThread("defaults");
  await agent.turn(1);
  assert.deepEqual(agent.settings[0], { model: "opus-5-5", effort: "xhigh", accessMode: "full", fastMode: false });
  assert.equal((await threads.get(thread.id)).thread.model, null);
  agent.finish("ok");
  await threads.send(thread.id, "less effort", { model: "opus-5-5", effort: "medium", accessMode: "full", fastMode: false });
  await agent.turn(2);
  assert.deepEqual(agent.settings[1], { model: "opus-5-5", effort: "medium", accessMode: "full", fastMode: false });
  assert.equal((await threads.get(thread.id)).thread.effort, "medium");
  agent.finish("done");
});

test("fast mode is saved with a message, applies from the next turn, and only where the model offers it", async () => {
  const { thread, agent } = await startThread("quick one", true);
  await agent.turn(1);
  assert.equal(agent.settings[0]?.fastMode, true);
  assert.equal((await threads.get(thread.id)).thread.fastMode, true);
  agent.finish("ok");
  await threads.send(thread.id, "slow down", { model: "opus-5-5", effort: "xhigh", accessMode: "full", fastMode: false });
  await agent.turn(2);
  assert.equal(agent.settings[1]?.fastMode, false);
  assert.equal((await threads.get(thread.id)).thread.fastMode, false);
  agent.finish("ok");
  // Kept on the thread, but not asked of a model without it.
  await threads.send(thread.id, "on haiku", { model: "haiku", effort: null, accessMode: "full", fastMode: true });
  await agent.turn(3);
  assert.equal(agent.settings[2]?.fastMode, false);
  assert.equal((await threads.get(thread.id)).thread.fastMode, true);
  agent.finish("done");
});

test("children inherit fast mode unless their model lacks it", async () => {
  await writeFile(
    settings.path,
    JSON.stringify({
      childModelRules: [
        { when: { provider: "claude", model: "opus-5-5", effort: "medium" }, use: { provider: "codex", model: null, effort: null } },
      ],
    }),
  );
  try {
    const { thread: parent, agent } = await startThread("fast parent", true);
    await agent.turn(1);
    agent.finish("ok");
    const child = (message: string) => threads.list().find((each) => each.parentId === parent.id && each.title.includes(message));
    const reply = await threads.startThread(parent.id, { message: "same model", watch: false, startFrom: "base" });
    assert.match(reply, /in fast mode/);
    assert.equal(child("same model")?.fastMode, true);
    await threads.startThread(parent.id, { message: "on haiku", watch: false, startFrom: "base", model: "haiku" });
    assert.equal(child("on haiku")?.fastMode, false);
    // The rule's Codex model has no fast mode.
    await threads.send(parent.id, "medium now", { model: "opus-5-5", effort: "medium", accessMode: "full", fastMode: true });
    await agent.turn(2);
    agent.finish("ok");
    await threads.startThread(parent.id, { message: "by rule", watch: false, startFrom: "base" });
    assert.deepEqual(
      [child("by rule")?.provider, child("by rule")?.fastMode],
      ["codex", false],
    );
  } finally {
    await rm(settings.path, { force: true });
  }
});

test("a child model rule turns fast mode on or off whatever the parent has", async () => {
  await writeFile(
    settings.path,
    JSON.stringify({
      childModelRules: [
        { when: { provider: "claude", model: "opus-5-5", effort: "xhigh" }, use: { provider: "claude", model: "opus-5-5", effort: "medium", fastMode: "on" } },
        { when: { provider: "claude", model: "opus-5-5", effort: "medium" }, use: { provider: "claude", model: "opus-5-5", effort: "medium", fastMode: "off" } },
        { when: { provider: "claude", model: "haiku", effort: null }, use: { provider: "claude", model: "haiku", effort: null, fastMode: "on" } },
      ],
    }),
  );
  try {
    const { thread: parent, agent } = await startThread("rule speeds");
    await agent.turn(1);
    agent.finish("ok");
    const child = (message: string) => threads.list().find((each) => each.parentId === parent.id && each.title.includes(message));
    // A standard-speed parent at xhigh: the rule turns it on.
    await threads.startThread(parent.id, { message: "rule on", watch: false, startFrom: "base" });
    assert.equal(child("rule on")?.fastMode, true);
    // A fast parent at medium: the rule turns it off.
    await threads.send(parent.id, "fast medium", { model: "opus-5-5", effort: "medium", accessMode: "full", fastMode: true });
    await agent.turn(2);
    agent.finish("ok");
    await threads.startThread(parent.id, { message: "rule off", watch: false, startFrom: "base" });
    assert.equal(child("rule off")?.fastMode, false);
    // On, but Haiku has no fast mode.
    await threads.send(parent.id, "on haiku", { model: "haiku", effort: null, accessMode: "full", fastMode: true });
    await agent.turn(3);
    agent.finish("ok");
    await threads.startThread(parent.id, { message: "rule haiku", watch: false, startFrom: "base" });
    assert.equal(child("rule haiku")?.fastMode, false);
  } finally {
    await rm(settings.path, { force: true });
  }
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
  const { workspacePath } = await threads.get(child!.id);
  assert.equal(await readFile(join(workspacePath, ".scratch", "brief.md"), "utf8"), "build it\n");

  childAgent.finish("Which database should I use?");
  const firstReport = await parentAgent.turn(2);
  assert.match(firstReport, /Report from thread/);
  assert.match(firstReport, /Which database should I use\?/);
  parentAgent.finish("waiting on the user");

  // The user answers the child directly; the outcome still reaches the parent.
  await threads.send(child!.id, "Use SQLite", { model: null, effort: null, accessMode: "full", fastMode: false });
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
    await threads.send(child!.id, "more", { model: null, effort: null, accessMode: "full", fastMode: false });
    await childAgent.turn(2);
    childAgent.finish("report two");
    await parentAgent.turn(3);
    parentAgent.finish("ok");
    await threads.send(child!.id, "more again", { model: null, effort: null, accessMode: "full", fastMode: false });
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

test("child model rules pick a child's model from its parent's, under the agent's explicit choices", async () => {
  await writeFile(
    settings.path,
    JSON.stringify({
      childModelRules: [
        // Saved when Claude listed its default as "default", which now names the default model.
        { when: { provider: "claude", model: "default" }, use: { provider: "codex", model: "gpt-6.1-sol", effort: "high" } },
      ],
    }),
  );
  try {
    // The parent is on Claude's defaults, which the rule names.
    const { thread: parent, agent: parentAgent } = await startThread("delegate");
    await parentAgent.turn(1);
    parentAgent.finish("ok");
    const choices = () =>
      threads
        .list()
        .filter((thread) => thread.parentId === parent.id)
        .map(({ provider, model, effort }) => `${provider} ${model} ${effort}`)
        .sort();

    const reply = await threads.startThread(parent.id, { message: "by rule", watch: false, startFrom: "base" });
    assert.match(reply, /with codex gpt-6\.1-sol at high effort, picked by the user's child model rules/);
    assert.deepEqual(choices(), ["codex gpt-6.1-sol high"]);

    // An explicit effort keeps the rule's model; another provider starts from that provider's
    // defaults, stored by name.
    await threads.startThread(parent.id, { message: "low effort", watch: false, startFrom: "base", effort: "low" });
    await threads.startThread(parent.id, { message: "on claude", watch: false, startFrom: "base", provider: "claude" });
    assert.deepEqual(choices(), ["claude opus-5-5 xhigh", "codex gpt-6.1-sol high", "codex gpt-6.1-sol low"]);
  } finally {
    await rm(settings.path, { force: true });
  }
});

test("a main-checkout thread's scratch folder is deleted with the thread", async () => {
  const thread = await threads.create({
    project: "demo",
    text: "look around",
    provider: "claude",
    model: null,
    effort: null,
    accessMode: "full",
    fastMode: false,
    isolated: false,
    captain: false,
  });
  const agent = await agentOf(thread.id);
  await agent.turn(1);
  const scratch = join(projects.projectPath("demo"), "scratch", thread.id);
  assert.ok(existsSync(scratch));
  agent.finish("done");
  await threads.delete(thread.id, false);
  assert.ok(!existsSync(scratch));
});

test("a merged or closed pull request wakes its thread, and a watched child's report reaches its parent", async () => {
  const { thread: parent, agent: parentAgent } = await startThread("lead the work");
  await parentAgent.turn(1);
  parentAgent.finish("ok");
  await threads.startThread(parent.id, { message: "do a part", watch: true, startFrom: "base" });
  const [child] = threads.list().filter((thread) => thread.parentId === parent.id);
  const childAgent = await agentOf(child!.id);
  await childAgent.turn(1);
  childAgent.finish("opened a PR");
  await parentAgent.turn(2);
  parentAgent.finish("waiting for review");

  const pr = (number: number): LinkedPullRequest => ({
    repo: "demo",
    number,
    url: `https://github.com/me/demo/pull/${number}`,
    state: "OPEN",
    title: `PR ${number}`,
    headOid: "abc",
  });
  const github = (number: number, state: string) => remote.set(pr(number).url, { state, title: `PR ${number}`, headOid: "abc" });
  db.linkPullRequest(parent.id, pr(3));
  db.linkPullRequest(child!.id, pr(7));
  db.linkPullRequest(child!.id, pr(8));

  // A title change is not news; a merge wakes the child, whose report wakes the parent.
  remote.set(pr(3).url, { state: "OPEN", title: "Renamed", headOid: "abc" });
  github(7, "MERGED");
  await threads.refreshOpenPullRequests();
  assert.equal(await childAgent.turn(2), `From borkcode, not the user:\n\ndemo#7 was merged: ${pr(7).url}`);
  assert.equal((await userItems(child!.id)).at(-1)?.fromBorkcode, true);
  childAgent.finish("Synced past demo#7.");
  const report = await parentAgent.turn(3);
  assert.match(report, /Report from thread[\s\S]*demo #7 MERGED[\s\S]*Synced past demo#7\./);
  parentAgent.finish("told the user");

  // The parent's own pull request wakes the parent the same way.
  github(3, "CLOSED");
  await threads.refreshOpenPullRequests();
  assert.match(await parentAgent.turn(4), /^From borkcode, not the user:\n\ndemo#3 was closed: /);
  parentAgent.finish("noted");

  // A merge found as the user's message starts a turn joins that turn instead of waking the next.
  github(8, "MERGED");
  await threads.send(child!.id, "carry on", { model: null, effort: null, accessMode: "full", fastMode: false });
  const joined = await childAgent.turn(3);
  assert.match(joined, /demo#8 was merged/);
  assert.match(joined, /Message from the user:\n\ncarry on/);
  childAgent.finish("done");
  await parentAgent.turn(5);
  parentAgent.finish("ok");

  // Nothing is open any more, so there is nothing to poll, and nothing is told twice.
  const asked = lookups.length;
  await threads.refreshOpenPullRequests();
  assert.equal(lookups.length, asked);
  assert.deepEqual([...db.listInbox(child!.id), ...db.listInbox(parent.id)], []);
  assert.equal(childAgent.turns.length, 3);
  assert.equal(parentAgent.turns.length, 5);
});

test("archiving takes the subtree along, refuses while any of it works, and a message brings it back", async () => {
  const { thread: parent, agent: parentAgent } = await startThread("plan the work");
  await parentAgent.turn(1);
  await threads.startThread(parent.id, { message: "a part", watch: true, startFrom: "base" });
  const [child] = threads.list().filter((thread) => thread.parentId === parent.id);
  const childAgent = await agentOf(child!.id);
  await childAgent.turn(1);
  const archivedAt = (id: string) => threads.list().find((thread) => thread.id === id)?.archivedAt ?? null;

  assert.throws(() => threads.setArchived(parent.id, true), /still working/);
  parentAgent.finish("handed off");
  // The child is still working, so the parent cannot go either.
  assert.throws(() => threads.setArchived(parent.id, true), /still working/);
  assert.equal(archivedAt(parent.id), null);

  childAgent.finish("built the part");
  await parentAgent.turn(2);
  parentAgent.finish("noted");

  threads.setArchived(parent.id, true);
  assert.notEqual(archivedAt(parent.id), null);
  assert.notEqual(archivedAt(child!.id), null);

  // Unarchiving the child restores its parent too, so it stays nested.
  threads.setArchived(child!.id, false);
  assert.equal(archivedAt(parent.id), null);
  assert.equal(archivedAt(child!.id), null);

  // A parent's message unarchives an archived child before it works on it.
  threads.setArchived(child!.id, true);
  assert.equal(archivedAt(parent.id), null);
  threads.sendToThread(parent.id, child!.id, "one more thing");
  assert.match(await childAgent.turn(2), /one more thing/);
  assert.equal(archivedAt(child!.id), null);
  childAgent.finish("done");
});

test("an archived thread's pull request merging updates its state without waking it", async () => {
  const { thread, agent } = await startThread("ship it");
  await agent.turn(1);
  agent.finish("opened a PR");
  const pr: LinkedPullRequest = {
    repo: "demo",
    number: 21,
    url: "https://github.com/me/demo/pull/21",
    state: "OPEN",
    title: "PR 21",
    headOid: "abc",
  };
  db.linkPullRequest(thread.id, pr);
  threads.setArchived(thread.id, true);

  remote.set(pr.url, { state: "MERGED", title: "PR 21", headOid: "abc" });
  const merged = broadcastOf(
    (event) => event.type === "pullRequests.changed" && event.threadId === thread.id && event.pullRequests[0]?.state === "MERGED",
  );
  await threads.refreshOpenPullRequests();
  await merged;

  // Nothing queued for later either, so unarchiving does not replay the news.
  assert.deepEqual(db.listInbox(thread.id), []);
  assert.equal(agent.turns.length, 1);
  const after = (await threads.get(thread.id)).thread;
  assert.notEqual(after.archivedAt, null);
  assert.equal(after.status, "idle");
});

function unread(threadId: string): boolean {
  const thread = threads.list().find((each) => each.id === threadId)!;
  return thread.markedUnread || (thread.respondedAt !== null && thread.respondedAt > (thread.readAt ?? 0));
}

test("a finished or failed turn leaves the thread unread until the user reads it; a stopped one does not", async () => {
  const { thread, agent } = await startThread("look into it");
  await agent.turn(1);
  assert.equal(unread(thread.id), false);
  agent.finish("found it");
  assert.equal(unread(thread.id), true);

  // Reading is not activity, so the thread keeps its place in the lists.
  const updatedAt = () => threads.list().find((each) => each.id === thread.id)!.updatedAt;
  const activeAt = updatedAt();
  threads.setRead(thread.id, true);
  assert.equal(unread(thread.id), false);
  assert.equal(updatedAt(), activeAt);

  await threads.send(thread.id, "keep going", { model: null, effort: null, accessMode: "full", fastMode: false });
  await agent.turn(2);
  await threads.interrupt(thread.id);
  assert.equal(unread(thread.id), false);

  await threads.send(thread.id, "try again", { model: null, effort: null, accessMode: "full", fastMode: false });
  await agent.turn(3);
  agent.fail("provider exploded");
  assert.equal(unread(thread.id), true);
});

test("the user can mark a thread unread and read again, even before any response, without it counting as activity", async () => {
  const { thread, agent } = await startThread("look into it");
  await agent.turn(1);
  const stored = () => threads.list().find((each) => each.id === thread.id)!;
  assert.equal(stored().respondedAt, null);
  const activeAt = stored().updatedAt;

  const markedUnread = broadcastOf(
    (event) => event.type === "thread.updated" && event.thread.id === thread.id && event.thread.markedUnread,
  );
  threads.setRead(thread.id, false);
  await markedUnread;
  assert.equal(unread(thread.id), true);
  assert.equal(stored().updatedAt, activeAt);

  const markedRead = broadcastOf(
    (event) => event.type === "thread.updated" && event.thread.id === thread.id && !event.thread.markedUnread,
  );
  threads.setRead(thread.id, true);
  await markedRead;
  assert.equal(unread(thread.id), false);
  assert.equal(stored().updatedAt, activeAt);

  // After a response, marking unread and then read clears both the flag and the response.
  agent.finish("found it");
  const answeredAt = stored().updatedAt;
  threads.setRead(thread.id, true);
  threads.setRead(thread.id, false);
  assert.equal(unread(thread.id), true);
  threads.setRead(thread.id, true);
  assert.equal(unread(thread.id), false);
  assert.equal(stored().updatedAt, answeredAt);
});

test("a watched child's report is its parent's to read, unless the user joined the child's turn", async () => {
  const { thread: parent, agent: parentAgent } = await startThread("lead the work");
  await parentAgent.turn(1);
  parentAgent.finish("delegating");
  threads.setRead(parent.id, true);

  await threads.startThread(parent.id, { message: "do a part", watch: true, startFrom: "base" });
  const [child] = threads.list().filter((thread) => thread.parentId === parent.id);
  const childAgent = await agentOf(child!.id);
  await childAgent.turn(1);
  childAgent.finish("part done");
  assert.equal(unread(child!.id), false);
  await parentAgent.turn(2);
  assert.equal(unread(parent.id), false);
  parentAgent.finish("noted the part");
  assert.equal(unread(parent.id), true);

  await threads.send(child!.id, "one more tweak", { model: null, effort: null, accessMode: "full", fastMode: false });
  await childAgent.turn(2);
  childAgent.finish("tweaked");
  assert.equal(unread(child!.id), true);
  await parentAgent.turn(3);
  parentAgent.finish("ok");
});

test("coming back to borkcode checks open pull requests, at most once in a short while", async (t) => {
  // Starts well after the checks earlier tests made.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 3_600_000 });
  const { thread, agent } = await startThread("keep an eye on it");
  await agent.turn(1);
  agent.finish("ok");
  const url = "https://github.com/me/watched/pull/1";
  db.linkPullRequest(thread.id, { repo: "watched", number: 1, url, state: "OPEN", title: "PR 1", headOid: "abc" });
  /** Whether coming back asked GitHub about the pull request. */
  const comeBack = async () => {
    const before = lookups.length;
    await threads.refreshPullRequestsOnReturn();
    return lookups.slice(before).some((urls) => urls.includes(url));
  };

  assert.equal(await comeBack(), true);
  assert.equal(await comeBack(), false);
  t.mock.timers.tick(5_000);
  assert.equal(await comeBack(), true);
});

test("returning just after a poll refreshes every thread, including archived children in other projects", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 3_600_000 });
  const database = new Database(":memory:");
  const { thread, agent } = await startThread("refresh fixture");
  await agent.turn(1);
  agent.finish("ok");
  const template = db.getThread(thread.id)!;
  const events: ServerEvent[] = [];
  const calls: string[][] = [];
  let merged = false;
  for (const [id, project, parentId, archivedAt, updatedAt, readAt] of [
    ["old", "other", null, null, 1, null],
    ["recent", "demo", null, null, 3, null],
    ["child", "other", "old", 1, 2, 4],
  ] as const) {
    database.insertThread({ ...template, id, project, parentId, archivedAt, updatedAt, readAt, status: "idle" });
    database.linkPullRequest(id, {
      repo: id, number: 1, url: `https://github.com/me/${id}/pull/1`, state: "OPEN", title: id, headOid: "abc",
    });
  }
  const service = new ThreadService(database, projects, settings, (event) => events.push(event), "http://test/mcp/", attachments, {
    ...fakeDeps,
    pullRequestStates: async (urls) => {
      calls.push(urls);
      return new Map(urls.map((url) => [url, { state: merged ? "MERGED" : "OPEN", title: url, headOid: "abc" }]));
    },
  });
  // Hold deliveries so this test only observes persisted PR state and sidebar broadcasts.
  await service.shutdown();
  await service.refreshOpenPullRequests();
  merged = true;
  await service.refreshPullRequestsOnReturn();
  assert.equal(calls.length, 2, "a poll must not swallow the user's return check");
  assert.deepEqual(calls[1], ["child", "recent", "old"].map((id) => `https://github.com/me/${id}/pull/1`));
  for (const id of ["old", "recent", "child"]) {
    assert.equal(database.listPullRequests(id)[0]?.state, "MERGED");
    assert.ok(events.some((event) => event.type === "pullRequests.changed" && event.threadId === id && event.pullRequests[0]?.state === "MERGED"));
  }
  assert.deepEqual(database.listInbox("child"), [], "archived children are refreshed without being woken");
});

test("overlapping returns share bounded batches, and failed or slow batches do not hide successful updates", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 3_600_000 });
  const { thread, agent } = await startThread("batch fixture");
  await agent.turn(1);
  agent.finish("ok");
  const database = new Database(":memory:");
  database.insertThread({ ...db.getThread(thread.id)!, archivedAt: 1 });
  for (let number = 1; number <= 81; number++) {
    database.linkPullRequest(thread.id, {
      repo: "batch", number, url: `https://github.com/me/batch/pull/${number}`, state: "OPEN", title: "old", headOid: "abc",
    });
  }
  const batches: { urls: string[]; resolve: (states: Map<string, PullRequestState>) => void; reject: (error: Error) => void }[] = [];
  let fourthStarted = () => {};
  const fourth = new Promise<void>((resolve) => fourthStarted = resolve);
  let updated = () => {};
  const changed = new Promise<void>((resolve) => updated = resolve);
  const service = new ThreadService(database, projects, settings, (event) => {
    if (event.type === "pullRequests.changed") updated();
  }, "http://test/mcp/", attachments, {
    ...fakeDeps,
    pullRequestStates: (urls) => new Promise((resolve, reject) => {
      batches.push({ urls, resolve, reject });
      if (batches.length === 4) fourthStarted();
    }),
  });
  const poll = service.refreshOpenPullRequests();
  const returning = service.refreshPullRequestsOnReturn();
  await service.refreshPullRequestsOnReturn();
  t.mock.timers.tick(5_000);
  const anotherReturn = service.refreshPullRequestsOnReturn();
  assert.deepEqual(batches.map((batch) => batch.urls.length), [25, 25, 25]);
  batches[0]!.reject(new Error("offline repository"));
  await fourth;
  assert.equal(batches[3]!.urls.length, 6);
  const merged = (urls: string[]) => new Map(urls.map((url) => [url, { state: "MERGED", title: "new", headOid: "abc" }]));
  batches[2]!.resolve(merged(batches[2]!.urls));
  await changed;
  assert.equal(database.listPullRequests(thread.id)[50]?.state, "MERGED", "a slow batch does not delay successful broadcasts");
  batches[1]!.resolve(merged(batches[1]!.urls));
  batches[3]!.resolve(merged(batches[3]!.urls));
  await Promise.all([poll, returning, anotherReturn]);
  assert.equal(batches.length, 4, "returns do not duplicate an in-flight poll");
  assert.equal(database.listPullRequests(thread.id).filter((pr) => pr.state === "MERGED").length, 56);
});

const pick: Question = {
  header: "Next step",
  question: "What next?",
  options: [
    { label: "Tests", description: "Write the tests first." },
    { label: "Docs", description: "Write the docs first." },
  ],
  multiSelect: false,
};

test("a question waits for the user's answer, which reaches the agent and stays in the transcript", async () => {
  const { thread, agent } = await startThread("ask me");
  await agent.turn(1);
  const answered = agent.ask("q1", [pick, { ...pick, question: "Which also?", multiSelect: true }]);

  const pending = await threads.get(thread.id);
  assert.deepEqual(pending.questions.map((request) => request.id), ["q1"]);
  assert.equal(pending.thread.waiting, true);
  assert.throws(() => threads.answerQuestion(thread.id, "q1", [["Tests"]]), /one answer per question/);

  threads.answerQuestion(thread.id, "q1", [["Tests"], ["Docs", "and a changelog"]]);
  assert.deepEqual(await answered, [["Tests"], ["Docs", "and a changelog"]]);
  const after = await threads.get(thread.id);
  assert.deepEqual(after.questions, []);
  assert.equal(after.thread.waiting, false);
  const item = after.items.find((entry) => entry.id === "q1");
  assert.deepEqual(item?.kind === "question" && item.answers, [["Tests"], ["Docs", "and a changelog"]]);
  assert.throws(() => threads.answerQuestion(thread.id, "q1", [["Tests"]]), /no longer pending/);
  agent.finish("ok");
});

test("stopping the turn drops a pending question unanswered", async () => {
  const { thread, agent } = await startThread("ask then stop");
  await agent.turn(1);
  const answered = agent.ask("q2", [pick]);
  await threads.interrupt(thread.id);
  assert.equal(await answered, null);
  const after = await threads.get(thread.id);
  assert.deepEqual(after.questions, []);
  assert.equal(after.thread.waiting, false);
  const item = after.items.find((entry) => entry.id === "q2");
  assert.equal(item?.kind === "question" && item.answers, null);
});

test("attachments go with a message to the agent, steered or queued across a restart, and leave with the thread", async () => {
  const dbPath = join(home, "restart.sqlite");
  const before = new ThreadService(new Database(dbPath), projects, settings, emit, "http://test/mcp/", attachments, fakeDeps);
  const thread = await before.create({
    project: "demo",
    text: "first task",
    provider: "claude",
    model: null,
    effort: null,
    accessMode: "full",
    fastMode: false,
    isolated: true,
    captain: false,
  });
  const agent = await agentOf(thread.id, before);
  await agent.turn(1);
  const upload = () => before.upload(thread.id, "shot.png", "image/png", Readable.from([PNG]));
  const settingsNow = { model: null, effort: null, accessMode: "full" as const, fastMode: false };

  agent.steerable = true;
  const steered = await upload();
  await before.send(thread.id, "", settingsNow, [steered.id]);
  assert.deepEqual(agent.steers, [""]);
  assert.deepEqual(
    agent.attachments.at(-1)?.map((each) => each.id),
    [steered.id],
  );
  assert.deepEqual(await readFile(agent.attachments.at(-1)![0]!.path), PNG);

  agent.steerable = false;
  const queued = await upload();
  const notes = await before.upload(thread.id, "notes.txt", "text/plain", Readable.from([Buffer.from("plover")]));
  await before.send(thread.id, "and this one", settingsNow, [queued.id, notes.id]);
  assert.throws(() => before.send(thread.id, "missing", settingsNow, [randomUUID()]), /attach the file again/);

  // A restart ends the agent with the message still waiting.
  const restarted = new ThreadService(new Database(dbPath), projects, settings, emit, "http://test/mcp/", attachments, fakeDeps);
  const resumed = new Promise<void>((resolve) => (agentStarted = resolve));
  restarted.resumeQueued();
  await resumed;
  const next = agents.at(-1)!.agent;
  assert.equal(await next.turn(1), `${borkcodeMessage(SERVER_STOPPED_NOTE)}\n\n---\n\n${userMessage("and this one")}`);
  assert.deepEqual(next.attachments[0], [
    { ...queued, path: attachments.path(thread.id, queued) },
    { ...notes, path: join(attachments.dir(thread.id), notes.id, "notes.txt") },
  ]);
  assert.equal(await readFile(next.attachments[0]![1]!.path, "utf8"), "plover");
  const items = (await restarted.get(thread.id)).items.filter((item) => item.kind === "user");
  assert.deepEqual(
    items.map((item) => item.attachments?.map((each) => each.id) ?? []),
    [[], [steered.id], [queued.id, notes.id]],
  );
  assert.equal(restarted.attachmentFile(thread.id, queued.id)?.name, "shot.png");

  next.finish("done");
  await restarted.delete(thread.id, true);
  assert.equal(restarted.attachmentFile(thread.id, queued.id), null);
  assert.ok(!existsSync(attachments.dir(thread.id)));
});

test("a new thread takes its draft's uploads, sends the named ones with its first message, and refuses another draft's", async () => {
  const draftId = randomUUID();
  const other = randomUUID();
  const shot = await attachments.saveDraft(draftId, "shot.png", "image/png", Readable.from([PNG]));
  const unsent = await attachments.saveDraft(draftId, "removed.txt", "text/plain", Readable.from([Buffer.from("x")]));
  const elsewhere = await attachments.saveDraft(other, "other.txt", "text/plain", Readable.from([Buffer.from("y")]));
  const params = { ...SETTINGS_NOW, project: "demo", text: "look at this", provider: "claude" as const, isolated: true, captain: false };
  const before = threads.list().length;

  assert.throws(() => threads.create({ ...params, draftId, attachments: [shot.id, elsewhere.id] }), /attach the file again/);
  assert.throws(() => threads.create({ ...params, attachments: [shot.id] }), /attach the file again/);
  assert.throws(() => threads.create({ ...params, draftId: "../drafts", attachments: [] }), /Unknown draft/);
  assert.equal(threads.list().length, before);

  const thread = await threads.create({ ...params, draftId, attachments: [shot.id] });
  const agent = await agentOf(thread.id);
  assert.equal(await agent.turn(1), "look at this");
  assert.deepEqual(agent.attachments[0], [{ ...shot, path: attachments.path(thread.id, shot) }]);
  assert.deepEqual(await readFile(agent.attachments[0]![0]!.path), PNG);
  assert.deepEqual((await userItems(thread.id)).map((item) => item.attachments?.map((each) => each.id)), [[shot.id]]);
  // The whole draft moved, so it is served from the thread and deleted with it.
  assert.equal(threads.attachmentFile(thread.id, unsent.id)?.name, "removed.txt");
  assert.throws(() => attachments.resolveDraft(draftId, [shot.id]), /attach the file again/);
  assert.equal(threads.attachmentFile(thread.id, elsewhere.id), null);
  assert.deepEqual(attachments.resolveDraft(other, [elsewhere.id]), [elsewhere]);

  agent.finish("done");
  await threads.delete(thread.id, false);
  assert.ok(!existsSync(attachments.dir(thread.id)));
});

const SETTINGS_NOW = { model: null, effort: null, accessMode: "full" as const, fastMode: false };

function notices(items: Item[]): string[] {
  return items.flatMap((item) => (item.kind === "notice" ? [item.text] : []));
}

/** A service on its own database file, so a second one on the same file is a server restart. */
async function serviceWithThread(file: string, text: string) {
  const path = join(home, file);
  const service = new ThreadService(new Database(path), projects, settings, emit, "http://test/mcp/", attachments, fakeDeps);
  const thread = await service.create({ ...SETTINGS_NOW, project: "demo", text, provider: "claude", isolated: true, captain: false });
  await (await agentOf(thread.id, service)).turn(1);
  const restart = () => new ThreadService(new Database(path), projects, settings, emit, "http://test/mcp/", attachments, fakeDeps);
  return { service, thread, restart };
}

/** Sends a message after a restart and returns the turn it starts on the new agent session. */
async function nextTurn(service: ThreadService, threadId: string, text: string, n = 1): Promise<string> {
  await service.send(threadId, text, SETTINGS_NOW);
  return agents.at(-1)!.agent.turn(n);
}

test("a turn cut off by the server shutting down is not the user's stop, and the agent hears so once", async () => {
  const { service, thread, restart } = await serviceWithThread("shutdown.sqlite", "long task");
  await service.shutdown();
  const stopped = await service.get(thread.id);
  assert.equal(stopped.thread.status, "idle");
  assert.deepEqual(notices(stopped.items), ["Stopped: borkcode server shut down"]);

  const restarted = restart();
  assert.deepEqual(notices((await restarted.get(thread.id)).items), ["Stopped: borkcode server shut down"]);
  assert.equal(
    await nextTurn(restarted, thread.id, "continue"),
    `${borkcodeMessage(SERVER_STOPPED_NOTE)}\n\n---\n\n${userMessage("continue")}`,
  );
  agents.at(-1)!.agent.finish("checked and carried on");
  assert.equal(await nextTurn(restarted, thread.id, "and then", 2), "and then");
  agents.at(-1)!.agent.finish("done");
});

test("a turn still marked running at startup was cut off by the server, and the agent hears so", async () => {
  const { thread, restart } = await serviceWithThread("killed.sqlite", "long task");
  // The server was killed without a chance to record anything.
  const restarted = restart();
  const detail = await restarted.get(thread.id);
  assert.equal(detail.thread.status, "idle");
  assert.deepEqual(notices(detail.items), ["Stopped: borkcode server shut down"]);
  assert.ok((await nextTurn(restarted, thread.id, "continue")).startsWith(borkcodeMessage(SERVER_STOPPED_NOTE)));
  agents.at(-1)!.agent.finish("done");
});

test("the user stopping a turn is recorded as theirs, and the agent gets no server note", async () => {
  const { thread, agent } = await startThread("stop me");
  await agent.turn(1);
  await threads.interrupt(thread.id);
  await threads.send(thread.id, "go on", SETTINGS_NOW);
  assert.equal(await agent.turn(2), "go on");
  assert.deepEqual(notices((await threads.get(thread.id)).items), ["Interrupted"]);
  agent.finish("done");
});

/** The agent session a thread opens after `mark` sessions had started, e.g. the first after a restart. */
async function agentAfter(mark: number, threadId: string, service: ThreadService): Promise<FakeAgent> {
  const { workspacePath } = await service.get(threadId);
  for (;;) {
    const found = agents.slice(mark).find((entry) => entry.cwd === workspacePath);
    if (found) return found.agent;
    await new Promise<void>((resolve) => (agentStarted = resolve));
  }
}

/** A parent on its own database file with a child running its first turn. */
async function parentWithRunningChild(file: string, watch: boolean) {
  const { service, thread: parent, restart } = await serviceWithThread(file, "coordinate");
  (await agentOf(parent.id, service)).finish("ok");
  await service.startThread(parent.id, { message: "build it", watch, startFrom: "base" });
  const child = service.list().find((thread) => thread.parentId === parent.id)!;
  await (await agentOf(child.id, service)).turn(1);
  return { service, parent, child, restart };
}

for (const how of ["shutting down", "being killed"]) {
  test(`a watched child cut off by the server ${how} reports once to its parent after the restart`, async () => {
    const { service, parent, child, restart } = await parentWithRunningChild(`child-${how.split(" ")[0]}.sqlite`, true);
    if (how === "shutting down") {
      await service.shutdown();
      // Deliveries are blocked while stopping, so the report waits for the restart.
      assert.equal((await service.get(parent.id)).thread.queued, 1);
    }
    const restarted = restart();
    assert.equal((await restarted.get(parent.id)).thread.queued, 1);
    const mark = agents.length;
    restarted.resumeQueued();
    const parentAgent = await agentAfter(mark, parent.id, restarted);
    const turn = await parentAgent.turn(1);
    assert.match(turn, new RegExp(`Report from thread "${child.title}" \\(id ${child.id}\\)`));
    assert.match(turn, /cut off because the borkcode server stopped[\s\S]*send_to_thread/);
    // The parent's own turn had finished, so it gets no server note.
    assert.doesNotMatch(turn, /From borkcode/);
    const reports = (await restarted.get(parent.id)).items.filter(
      (item) => item.kind === "user" && item.fromThreadId === child.id,
    );
    assert.equal(reports.length, 1);
    assert.equal((await restarted.get(parent.id)).thread.queued, 0);
    // The child does not resume on its own.
    const childDetail = await restarted.get(child.id);
    assert.equal(childDetail.thread.status, "idle");
    assert.deepEqual(notices(childDetail.items), ["Stopped: borkcode server shut down"]);
    parentAgent.finish("noted");
  });
}

test("an unwatched child cut off by the server sends its parent no report", async () => {
  const { service, parent, child, restart } = await parentWithRunningChild("unwatched-child.sqlite", false);
  await service.shutdown();
  const restarted = restart();
  assert.deepEqual(notices((await restarted.get(child.id)).items), ["Stopped: borkcode server shut down"]);
  assert.equal((await restarted.get(parent.id)).thread.queued, 0);
  assert.equal((await restarted.get(child.id)).thread.queued, 0);
});

test("a new thread stopped while its workspace is being created gets its first message after the restart", async () => {
  const path = join(home, "preparing.sqlite");
  // The title never arrives, so the server stops before the workspace exists.
  const stuck = { ...fakeDeps, generateTitle: () => new Promise<string>(() => {}) };
  const service = new ThreadService(new Database(path), projects, settings, emit, "http://test/mcp/", attachments, stuck);
  const thread = await service.create({ ...SETTINGS_NOW, project: "demo", text: "first words", provider: "claude", isolated: true, captain: false });
  await service.shutdown();
  assert.equal((await service.get(thread.id)).thread.status, "preparing");

  const restarted = new ThreadService(new Database(path), projects, settings, emit, "http://test/mcp/", attachments, fakeDeps);
  const mark = agents.length;
  restarted.resumeQueued();
  const agent = await agentAfter(mark, thread.id, restarted);
  assert.equal(await agent.turn(1), "first words");
  const detail = await restarted.get(thread.id);
  assert.ok(existsSync(detail.workspacePath));
  assert.deepEqual(
    detail.items.flatMap((item) => (item.kind === "user" ? [item.text] : [])),
    ["first words"],
  );
  // No agent turn had started, so there is no server note.
  assert.deepEqual(notices(detail.items), []);
  agent.finish("hello");
});

test("show_html stores the page beside the attachments, records only its id and title, and can replace it", async () => {
  const { thread, agent } = await startThread("chart it");
  await agent.turn(1);
  const shown = await threads.showHtml(thread.id, { title: " Sales ", html: "<p>v1</p>" });
  const id = /id ([0-9a-f-]{36})/.exec(shown)?.[1];
  assert.ok(id, shown);
  const item = (await threads.get(thread.id)).items.find((candidate) => candidate.id === id);
  assert.deepEqual(item && { ...item, updatedAt: 0 }, { id, kind: "visualization", title: "Sales", updatedAt: 0 });
  assert.equal(await readFile(join(attachments.dir(thread.id), "visualizations", `${id}.html`), "utf8"), "<p>v1</p>");
  assert.match(String((await threads.visualizationPage(thread.id, id))?.html), /^<p>v1<\/p>\n<script>/);

  const { workspacePath } = await threads.get(thread.id);
  await writeFile(join(workspacePath, ".scratch", "chart.html"), "<p>v2</p>");
  agent.say("Here is a new version.");
  // The replacement moves to the end, after what was added since, and live clients are told so.
  const moved = broadcastOf((event) => event.type === "item.upserted" && event.item.id === id && event.toEnd === true);
  assert.match(
    await threads.showHtml(thread.id, { title: "Sales by month", path: ".scratch/chart.html", id }),
    /^Updated "Sales by month" and moved it to the end of the thread .* served live from the file/,
  );
  await moved;
  assert.deepEqual((await threads.get(thread.id)).items.slice(-2).map((candidate) => candidate.kind === "assistant" ? candidate.text : candidate.id), [
    "Here is a new version.",
    id,
  ]);
  assert.equal(await threads.visualizationAsset(thread.id, id, "chart.html"), join(workspacePath, ".scratch", "chart.html"));
  const visualizations = (await threads.get(thread.id)).items.filter((candidate) => candidate.kind === "visualization");
  assert.deepEqual(visualizations.map((candidate) => [candidate.id, candidate.kind === "visualization" && candidate.title]), [
    [id, "Sales by month"],
  ]);
  assert.match(String((await threads.visualizationPage(thread.id, id))?.html), /^<p>v2<\/p>/);

  // Only this thread's own visualizations can be replaced or served.
  const other = await startThread("elsewhere");
  await other.agent.turn(1);
  await assert.rejects(threads.showHtml(other.thread.id, { title: "x", html: "<p/>", id }), /no visualization/);
  assert.equal(await threads.visualizationPage(other.thread.id, id), null);
  const notVisualization = (await userItems(thread.id))[0]!.id;
  await assert.rejects(threads.showHtml(thread.id, { title: "x", html: "<p/>", id: notVisualization }), /no visualization/);

  await assert.rejects(threads.showHtml(thread.id, { title: "x", html: "x".repeat(MAX_VISUALIZATION_BYTES + 1) }), /at most 2 MB/);
  await assert.rejects(threads.showHtml(thread.id, { title: "x", html: "" }), /empty/);
  await assert.rejects(threads.showHtml(thread.id, { title: "x" }), /either html or path/);
  await assert.rejects(threads.showHtml(thread.id, { title: "x", html: "<p/>", path: "a.html" }), /either html or path/);
  await assert.rejects(threads.showHtml(thread.id, { title: "x", path: "missing.html" }), /no file/);
  await assert.rejects(threads.showHtml(thread.id, { title: " ", html: "<p/>" }), /title/);

  agent.finish("done");
  other.agent.finish("done");
  await threads.delete(thread.id, true);
  assert.ok(!existsSync(attachments.dir(thread.id)));
});

test("automatic archiving tucks away inactive subtrees with a notice, and does nothing when off", async () => {
  const archiveHome = await mkdtemp(join(tmpdir(), "borkcode-archive-"));
  after(() => rm(archiveHome, { recursive: true, force: true }));
  const archiveSettings = new SettingsStore(archiveHome);
  const events: ServerEvent[] = [];
  const archiveDb = new Database(":memory:");
  const service = new ThreadService(
    archiveDb,
    projects,
    archiveSettings,
    (event) => events.push(event),
    "http://test/mcp/",
    attachments,
    fakeDeps,
  );
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now() + 30 * day;
  const seed = (id: string, parentId: string | null, status: "idle" | "running" = "idle", captain = false) =>
    archiveDb.insertThread({
      id,
      project: "demo",
      title: id,
      provider: "claude",
      model: null,
      effort: null,
      accessMode: "full",
      fastMode: false,
      workspace: null,
      branch: null,
      status,
      providerSessionId: null,
      startBranch: null,
      parentId,
      captain,
      watched: false,
      paused: false,
      queued: 0,
      archivedAt: null,
      respondedAt: null,
      readAt: null,
      markedUnread: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  seed("captain", null);
  seed("busy", "captain", "running");
  seed("done", "captain");
  seed("lonely", null);
  seed("finished", "lonely");
  seed("coordinator", null, "idle", true);
  seed("handed off", "coordinator");
  const archived = () => service.list().filter((thread) => thread.archivedAt !== null).map((thread) => thread.id).sort();
  const notices = async (id: string) =>
    (await service.get(id)).items.flatMap((item) => (item.kind === "notice" ? [item.text] : []));

  await archiveSettings.update({ ...DEFAULT_SETTINGS, autoArchive: { enabled: false, days: 7 } });
  await service.autoArchive(now);
  assert.deepEqual(archived(), []);

  await archiveSettings.update({ ...DEFAULT_SETTINGS, autoArchive: { enabled: true, days: 31 } });
  await service.autoArchive(now);
  assert.deepEqual(archived(), []);

  await archiveSettings.update({ ...DEFAULT_SETTINGS, autoArchive: { enabled: true, days: 7 } });
  const before = service.list().map((thread) => thread.updatedAt);
  await service.autoArchive(now);
  assert.deepEqual(archived(), ["done", "finished", "handed off", "lonely"]);
  assert.deepEqual(await notices("lonely"), ["Archived automatically after 7 days inactive"]);
  assert.deepEqual(await notices("finished"), ["Archived automatically after 7 days inactive"]);
  assert.deepEqual(await notices("captain"), []);
  assert.deepEqual(await notices("coordinator"), []);
  assert.ok(events.some((event) => event.type === "thread.updated" && event.thread.id === "lonely" && event.thread.archivedAt !== null));
  // Archiving is not activity.
  assert.deepEqual(service.list().map((thread) => thread.updatedAt), before);

  // Already archived threads are left alone, without a second notice.
  await service.autoArchive(now);
  assert.deepEqual(await notices("lonely"), ["Archived automatically after 7 days inactive"]);
});
