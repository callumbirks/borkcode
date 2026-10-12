import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileTarget } from "shared/protocol";
import {
  codePath,
  fileUrl,
  findBarePaths,
  labelTarget,
  splitLines,
  targetLabel,
  toolPaths,
  type FileLinker,
} from "./fileLinks.ts";
import { renderMarkdown } from "./markdown.ts";

test("line suffixes are split off paths", () => {
  assert.deepEqual(splitLines("src/main.ts"), { path: "src/main.ts", lines: null });
  assert.deepEqual(splitLines("src/main.ts:42"), { path: "src/main.ts", lines: { start: 42, end: 42 } });
  assert.deepEqual(splitLines("src/main.ts:42-50"), { path: "src/main.ts", lines: { start: 42, end: 50 } });
  assert.deepEqual(splitLines("src/main.ts:42:7"), { path: "src/main.ts", lines: { start: 42, end: 42 } });
  assert.deepEqual(splitLines("src/main.ts#L3-L9"), { path: "src/main.ts", lines: { start: 3, end: 9 } });
  assert.deepEqual(splitLines("src/main.ts:9-3"), { path: "src/main.ts", lines: { start: 9, end: 9 } });
  assert.deepEqual(splitLines(":42"), { path: ":42", lines: null });
});

test("code spans are paths only when they look like one", () => {
  assert.deepEqual(codePath("server/src/main.ts:42"), { path: "server/src/main.ts", lines: { start: 42, end: 42 } });
  assert.deepEqual(codePath("ROADMAP.md"), { path: "ROADMAP.md", lines: null });
  assert.deepEqual(codePath("web/src/"), { path: "web/src/", lines: null });
  for (const code of ["pnpm test", "main", "https://x.dev/a.ts", "--flag/x", "~/notes.md", "a b/c.ts", ""]) {
    assert.equal(codePath(code), null, code);
  }
});

test("bare paths need a folder and an extension, and skip URLs and punctuation", () => {
  const found = (text: string) => findBarePaths(text).map((path) => text.slice(path.start, path.end));
  assert.deepEqual(found("See server/src/main.ts:42, and ./web/a.svelte."), ["server/src/main.ts:42", "./web/a.svelte"]);
  assert.deepEqual(found("Edited /home/me/ws/app/x.ts and ../lib/y.rs:3-4"), ["/home/me/ws/app/x.ts", "../lib/y.rs:3-4"]);
  assert.deepEqual(found("https://github.com/a/b.ts and main.ts and e.g. and and/or and 1/2.5"), []);
  assert.deepEqual(findBarePaths("in a/b.ts:3-5.")[0], { start: 3, end: 13, path: "a/b.ts", lines: { start: 3, end: 5 } });
});

test("tool calls name their files", () => {
  assert.deepEqual(toolPaths("Read", "/ws/app/a.ts"), ["/ws/app/a.ts"]);
  assert.deepEqual(toolPaths("Edit", "/ws/app/my file.ts"), ["/ws/app/my file.ts"]);
  assert.deepEqual(toolPaths("edit", "/ws/a.ts, /ws/b.ts"), ["/ws/a.ts", "/ws/b.ts"]);
  assert.deepEqual(toolPaths("Bash", "cat a.ts"), []);
  assert.deepEqual(toolPaths("Read", ""), []);
});

test("labels and urls round-trip", () => {
  assert.equal(targetLabel({ root: "project", path: "plan.md" }), "Project files/plan.md");
  assert.deepEqual(labelTarget("Project files/plan.md"), { root: "project", path: "plan.md" });
  assert.deepEqual(labelTarget("app/src/a.ts"), { root: "workspace", path: "app/src/a.ts" });
  assert.equal(fileUrl("t1", { root: "workspace", path: "app/a b.ts" }), "/api/threads/t1/files?root=workspace&path=app%2Fa%20b.ts");
});

const known: Record<string, FileTarget> = {
  "server/src/main.ts": { root: "workspace", path: "app/server/src/main.ts", kind: "file" },
  "/ws/app/README.md": { root: "workspace", path: "app/README.md", kind: "file" },
};
const asked: string[] = [];
const links: FileLinker = {
  find(path) {
    asked.push(path);
    return known[path] ?? null;
  },
  href: (target) => fileUrl("t1", target),
};
const link = (path: string, lines: string | null, title: string, inner: string, className = "file-link") =>
  `<a class="${className}" href="/api/threads/t1/files?root=workspace&#38;path=${encodeURIComponent(path)}" ` +
  `data-file-root="workspace" data-file-path="${path}"${lines ? ` data-file-lines="${lines}"` : ""} title="${title}">${inner}</a>`;

test("paths that resolve become links in code spans and prose; others stay as they were", () => {
  asked.length = 0;
  const html = renderMarkdown(
    "Look at `server/src/main.ts:42`, /ws/app/README.md and `web/missing.ts`, not `pnpm test`.",
    [],
    null,
    links,
  );
  assert.equal(
    html,
    `<p>Look at ${link("app/server/src/main.ts", "42-42", "app/server/src/main.ts:42", "<code>server/src/main.ts:42</code>")}, ` +
      `${link("app/README.md", null, "app/README.md", "/ws/app/README.md")} and <code>web/missing.ts</code>, not <code>pnpm test</code>.</p>\n`,
  );
  assert.ok(asked.includes("web/missing.ts") && !asked.includes("pnpm test"));
});

test("paths inside links and code blocks are left alone", () => {
  const html = renderMarkdown("[`server/src/main.ts`](https://x.dev)\n\n```\nserver/src/main.ts\n```", [], null, links);
  assert.ok(!html.includes("file-link"), html);
});

test("file chips link to the preview when there is a linker", () => {
  const roots = { repos: ["app"], workspace: "/ws", projectFiles: "/p/files" };
  assert.equal(
    renderMarkdown("Read @app/README.md", [], roots, links),
    `<p>Read ${link("app/README.md", null, "app/README.md", "README.md", "file-chip")}</p>\n`,
  );
});
