import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project, Thread } from "shared/protocol";
import { buildInstructions } from "./instructions.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";

const project: Project = {
  name: "demo",
  path: "/home/me/borkcode/projects/demo",
  repos: [{ name: "app", url: "git@example.com:app.git", baseBranch: "main" }],
};

function thread(branch: string | null): Thread {
  return {
    id: "t1",
    project: "demo",
    title: "Fix login",
    provider: "claude",
    model: null,
    effort: null,
    accessMode: "ask",
    workspace: branch ? "fix-login-t1" : null,
    branch,
    status: "idle",
    parentId: null,
    captain: false,
    watched: false,
    queued: 0,
    paused: false,
    createdAt: 0,
    updatedAt: 0,
  };
}

const context = { scratch: "/ws/.scratch", parent: null, brief: null };

const AUTO = /without waiting to be asked/;
const ON_REQUEST = /Only commit when the user asks/;

test("worktree threads commit as they go when auto-commit is on", () => {
  const text = buildInstructions(project, thread("borkcode/fix-login-t1"), "/ws", DEFAULT_SETTINGS, context);
  assert.match(text, AUTO);
  assert.match(text, /Commit on borkcode\/fix-login-t1/);
  assert.doesNotMatch(text, ON_REQUEST);
});

test("threads commit only on request when auto-commit is off or in the main checkouts", () => {
  const off = buildInstructions(project, thread("borkcode/fix-login-t1"), "/ws", {
    ...DEFAULT_SETTINGS,
    autoCommit: false,
  }, context);
  const main = buildInstructions(project, thread(null), "/ws", DEFAULT_SETTINGS, context);
  for (const text of [off, main]) {
    assert.match(text, ON_REQUEST);
    assert.doesNotMatch(text, AUTO);
  }
});

test("captains may start threads unprompted; other threads only when asked", () => {
  const captain = buildInstructions(project, { ...thread("borkcode/fix-login-t1"), captain: true }, "/ws", DEFAULT_SETTINGS, context);
  assert.match(captain, /You are a captain/);
  assert.match(captain, /do not need to be asked each time/);
  assert.match(captain, /delegate it to threads, even if it looks small/);
  assert.match(captain, /send them to that thread with send_to_thread instead of starting a new one/);
  assert.match(captain, /read its pull request diff/);
  const regular = buildInstructions(project, thread("borkcode/fix-login-t1"), "/ws", DEFAULT_SETTINGS, context);
  assert.doesNotMatch(regular, /You are a captain/);
  assert.match(regular, /Only start threads when asked/);
});

test("a child thread learns that its replies reach its parent", () => {
  const child = buildInstructions(project, thread("borkcode/fix-login-t1"), "/ws", DEFAULT_SETTINGS, {
    ...context,
    parent: { title: "Plan the login work", captain: false },
    brief: "/ws/.scratch/brief.md",
  });
  assert.match(child, /started by the agent of another thread, "Plan the login work"/);
  assert.match(child, /your reply still reaches your parent/);
  assert.match(child, /saved at \/ws\/\.scratch\/brief\.md/);
  assert.doesNotMatch(buildInstructions(project, thread(null), "/ws", DEFAULT_SETTINGS, context), /Your parent thread/);
});

test("children of a captain open pull requests when their work item is done", () => {
  const instructions = (captain: boolean) =>
    buildInstructions(project, thread("borkcode/fix-login-t1"), "/ws", DEFAULT_SETTINGS, {
      ...context,
      parent: { title: "Plan the login work", captain },
    });
  assert.match(instructions(true), /open pull requests with open_pull_requests before your final reply/);
  assert.match(instructions(true), /run the verification your change needs/);
  assert.doesNotMatch(instructions(false), /Your parent is a captain/);
});

test("working files go to the thread's scratch folder, not the project files", () => {
  const text = buildInstructions(project, thread("borkcode/fix-login-t1"), "/ws", DEFAULT_SETTINGS, context);
  assert.match(text, /use your scratch folder, \/ws\/\.scratch\. It is outside every repository/);
  assert.match(text, /never working files/);
});
