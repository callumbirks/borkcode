import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Item, LinkedPullRequest, ServerEvent } from "shared/protocol";
import { Database } from "./db.ts";
import { ProjectStore } from "./projects.ts";
import type { PullRequestState } from "./pullRequests.ts";
import type { ProviderSession, SessionEvents, TurnSettings } from "./providers/types.ts";
import { SettingsStore } from "./settings.ts";
import { ThreadService } from "./threads.ts";

/** A scripted agent: records what it is sent and ends turns when the test says so. */
class FakeAgent implements ProviderSession {
  readonly turns: string[] = [];
  readonly settings: TurnSettings[] = [];
  readonly steers: string[] = [];
  /** Whether a message can join the running turn, as when a tool call is in progress. */
  steerable = false;
  readonly #events: SessionEvents;
  #waiting: (() => void)[] = [];

  constructor(events: SessionEvents) {
    this.#events = events;
  }

  async sendTurn(text: string, settings: TurnSettings) {
    this.turns.push(text);
    this.settings.push(settings);
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

  fail(error: string) {
    this.#events.turnEnded({ status: "failed", error });
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

const db = new Database(":memory:");
const threads = new ThreadService(db, projects, settings, emit, "http://test/mcp/", {
  startSession: async (_provider, options) => {
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
      ? [{ id: "opus-5-5", name: "Opus 5.5", isDefault: true, efforts: ["medium", "xhigh"], defaultEffort: "xhigh" }]
      : [{ id: "gpt-6.1-sol", name: "GPT 6.1 Sol", isDefault: true, efforts: ["low", "high"], defaultEffort: "low" }],
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

  await threads.send(thread.id, "while you work", { model: null, effort: null, accessMode: "full" });
  assert.equal((await threads.get(thread.id)).thread.queued, 1);
  agent.finish("done with the first");
  assert.equal(await agent.turn(2), "while you work");

  agent.steerable = true;
  await threads.send(thread.id, "and also this", { model: null, effort: null, accessMode: "full" });
  assert.deepEqual(agent.steers, ["and also this"]);
  const steered = (await userItems(thread.id)).at(-1);
  assert.equal(steered?.text, "and also this");
  assert.equal(steered?.steered, true);
  assert.equal((await threads.get(thread.id)).thread.queued, 0);
  agent.finish("done");
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
  await threads.send(thread.id, "go ahead", { model: null, effort: null, accessMode: "ask" });
  await agent.turn(2);
  assert.equal(agent.settings[1]?.accessMode, "ask");
  assert.equal((await threads.get(thread.id)).thread.accessMode, "ask");
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
  const { workspacePath } = await threads.get(child!.id);
  assert.equal(await readFile(join(workspacePath, ".scratch", "brief.md"), "utf8"), "build it\n");

  childAgent.finish("Which database should I use?");
  const firstReport = await parentAgent.turn(2);
  assert.match(firstReport, /Report from thread/);
  assert.match(firstReport, /Which database should I use\?/);
  parentAgent.finish("waiting on the user");

  // The user answers the child directly; the outcome still reaches the parent.
  await threads.send(child!.id, "Use SQLite", { model: null, effort: null, accessMode: "full" });
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
    await threads.send(child!.id, "more", { model: null, effort: null, accessMode: "full" });
    await childAgent.turn(2);
    childAgent.finish("report two");
    await parentAgent.turn(3);
    parentAgent.finish("ok");
    await threads.send(child!.id, "more again", { model: null, effort: null, accessMode: "full" });
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
        { when: { provider: "claude", model: "opus-5-5" }, use: { provider: "codex", model: "gpt-6.1-sol", effort: "high" } },
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

    // An explicit effort keeps the rule's model; another provider starts from that provider's defaults.
    await threads.startThread(parent.id, { message: "low effort", watch: false, startFrom: "base", effort: "low" });
    await threads.startThread(parent.id, { message: "on claude", watch: false, startFrom: "base", provider: "claude" });
    assert.deepEqual(choices(), ["claude null null", "codex gpt-6.1-sol high", "codex gpt-6.1-sol low"]);
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
  await threads.send(child!.id, "carry on", { model: null, effort: null, accessMode: "full" });
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
  return thread.respondedAt !== null && thread.respondedAt > (thread.readAt ?? 0);
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
  threads.markRead(thread.id);
  assert.equal(unread(thread.id), false);
  assert.equal(updatedAt(), activeAt);

  await threads.send(thread.id, "keep going", { model: null, effort: null, accessMode: "full" });
  await agent.turn(2);
  await threads.interrupt(thread.id);
  assert.equal(unread(thread.id), false);

  await threads.send(thread.id, "try again", { model: null, effort: null, accessMode: "full" });
  await agent.turn(3);
  agent.fail("provider exploded");
  assert.equal(unread(thread.id), true);
});

test("a watched child's report is its parent's to read, unless the user joined the child's turn", async () => {
  const { thread: parent, agent: parentAgent } = await startThread("lead the work");
  await parentAgent.turn(1);
  parentAgent.finish("delegating");
  threads.markRead(parent.id);

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

  await threads.send(child!.id, "one more tweak", { model: null, effort: null, accessMode: "full" });
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
  t.mock.timers.tick(15_000);
  assert.equal(await comeBack(), true);
});
