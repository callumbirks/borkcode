import assert from "node:assert/strict";
import { test } from "node:test";
import { newThreadDraftKey, parseRoute, routeHash, type Route } from "./routes.ts";

test("every route survives a round trip through the URL, including names that need escaping", () => {
  const routes: Route[] = [
    { view: "home" },
    { view: "settings" },
    { view: "archived" },
    { view: "project", name: "my app/2" },
    { view: "new", project: "my app/2" },
    { view: "file", project: "demo", path: "specs/new/login.md" },
    { view: "thread", id: "4f0c1c55-7f39-4a3a-9d0e-3c1b0c8e2a11" },
  ];
  for (const route of routes) assert.deepEqual(parseRoute(routeHash(route)), route);
});

test("a project's new-thread page is its own route, and a project named new is still a project", () => {
  assert.deepEqual(parseRoute("#/project/demo/new"), { view: "new", project: "demo" });
  assert.deepEqual(parseRoute("#/project/new"), { view: "project", name: "new" });
  assert.deepEqual(parseRoute("#/nonsense"), { view: "home" });
});

test("new-thread drafts are one per project and never collide with a thread's", () => {
  assert.equal(newThreadDraftKey("demo"), "new:demo");
  assert.notEqual(newThreadDraftKey("demo"), newThreadDraftKey("other"));
  assert.doesNotMatch(newThreadDraftKey("demo"), /^[0-9a-f-]{36}$/);
});
