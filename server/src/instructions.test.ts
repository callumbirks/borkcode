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
    createdAt: 0,
    updatedAt: 0,
  };
}

const AUTO = /without waiting to be asked/;
const ON_REQUEST = /Only commit when the user asks/;

test("worktree threads commit as they go when auto-commit is on", () => {
  const text = buildInstructions(project, thread("borkcode/fix-login-t1"), "/ws", DEFAULT_SETTINGS);
  assert.match(text, AUTO);
  assert.match(text, /Commit on borkcode\/fix-login-t1/);
  assert.doesNotMatch(text, ON_REQUEST);
});

test("threads commit only on request when auto-commit is off or in the main checkouts", () => {
  const off = buildInstructions(project, thread("borkcode/fix-login-t1"), "/ws", {
    ...DEFAULT_SETTINGS,
    autoCommit: false,
  });
  const main = buildInstructions(project, thread(null), "/ws", DEFAULT_SETTINGS);
  for (const text of [off, main]) {
    assert.match(text, ON_REQUEST);
    assert.doesNotMatch(text, AUTO);
  }
});
