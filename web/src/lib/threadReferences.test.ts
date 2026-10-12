import assert from "node:assert/strict";
import { test } from "node:test";
import { findReferences, findThreadReferences, isThreadReference, threadReference } from "./threadReferences.ts";
import { renderMarkdown } from "./markdown.ts";
import { insertMention } from "./mentions.ts";

const id = "12345678-1234-1234-1234-123456789abc";
const threads = [{ id, title: "Discuss <architecture>", project: "demo", status: "idle" as const, archivedAt: null }];
const ref = threadReference(id);

test("thread references insert from @, parse UUIDs and preserve sentence punctuation", () => {
  assert.deepEqual(insertMention("See @arc", 4, 8, ref), { text: `See ${ref} `, caret: 4 + ref.length + 1 });
  const text = `See (${ref}), then ${ref.toUpperCase()}.`;
  const parsed = findThreadReferences(text, threads);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, "Discuss <architecture>");
  assert.equal(parsed[0].label, "demo · idle");
  assert.equal(text.slice(parsed[0].start, parsed[0].end), ref);
  assert.equal(parsed[1].threadId, id);
  assert.deepEqual(findThreadReferences(`x${ref} ${ref}extra ${ref}-extra borkcode:thread:bad`, threads), []);
});

test("file and thread references combine in text order, even with no file roots", () => {
  const roots = { repos: ["app"], workspace: "/w", projectFiles: "/p/files" };
  const refs = findReferences(`@app/x.ts ${ref}`, roots, threads);
  assert.equal(refs.length, 2);
  assert.equal(isThreadReference(refs[0]), false);
  assert.equal(isThreadReference(refs[1]), true);
  assert.equal(findReferences(ref, null, threads).length, 1);
});

test("archived and missing references remain visible, current titles/status drive labels", () => {
  assert.equal(findThreadReferences(ref, [{ ...threads[0], status: "running", archivedAt: 1 }])[0].label, "demo · running · archived");
  assert.equal(findThreadReferences(ref, [])[0].name, "Deleted thread");
});

test("markdown renders navigable escaped chips while code and link text stay plain", () => {
  const html = renderMarkdown(`Read ${ref}.`, [], null, null, threads);
  assert.match(html, new RegExp(`href="#/thread/${id}"`));
  assert.ok(html.includes("Discuss &#60;architecture&#62;"));
  assert.ok(html.includes('title="demo · idle"'));
  for (const text of [`\`${ref}\``, `\`\`\`\n${ref}\n\`\`\``, `[${ref}](https://example.com)`]) {
    assert.ok(!renderMarkdown(text, [], null, null, threads).includes("thread-chip"));
  }
});
