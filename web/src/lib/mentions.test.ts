import assert from "node:assert/strict";
import { test } from "node:test";
import { enterThreadMode, insertMention, matchesThreadCategory, mentionAt, mentionSearch, pickerEntries } from "./mentions.ts";

test("an @ at a word boundary starts a reference up to the caret", () => {
  assert.deepEqual(mentionAt("@", 1), { start: 0, query: "" });
  assert.deepEqual(mentionAt("look at @src/ma", 15), { start: 8, query: "src/ma" });
  assert.deepEqual(mentionAt("look at @src/main.ts", 12), { start: 8, query: "src" });
  assert.deepEqual(mentionAt("one\n@two", 8), { start: 4, query: "two" });
  assert.equal(mentionAt("me@example.com", 14), null);
  assert.equal(mentionAt("@done and more", 14), null);
  assert.equal(mentionAt("no mention", 10), null);
});

test("picking replaces the typed reference and adds one space", () => {
  assert.deepEqual(insertMention("see @ma", 4, 7, "@app/main.ts"), {
    text: "see @app/main.ts ",
    caret: 17,
  });
  assert.deepEqual(insertMention("see @ma please", 4, 7, "@app/main.ts"), {
    text: "see @app/main.ts please",
    caret: 17,
  });
  assert.deepEqual(insertMention("see @mapp.ts", 4, 6, "@app/main.ts"), {
    text: "see @app/main.ts ",
    caret: 17,
  });
});


test("thread mode is derived from the typed prefix and returns to mixed mode without its colon", () => {
  for (const query of ["thread:", "THREAD:", "Thread:notes"]) {
    assert.deepEqual(mentionSearch(query), { mode: "threads", query: query.slice(7) });
  }
  for (const query of ["", "thread", "threa", "notes", "thread/notes", "threads:notes"]) {
    assert.deepEqual(mentionSearch(query), { mode: "mixed", query });
  }
  const typing = mentionAt("See @thread:notes", 17)!;
  assert.equal(typing.start, 4);
  assert.equal(mentionSearch(typing.query).mode, "threads");
  assert.equal(mentionSearch(mentionAt("See @thread", 11)!.query).mode, "mixed");
});

test("Threads category matches empty text and case-insensitive prefixes only", () => {
  for (const query of ["", "t", "th", "thre", "thread", "threads", "ThrEaDs"]) assert.equal(matchesThreadCategory(query), true);
  for (const query of ["thread:", "threadsX", "reads", "other", " threads"]) assert.equal(matchesThreadCategory(query), false);
});

test("bare @ offers just the category and files; thread mode omits the category and files", () => {
  const file = { kind: "file" as const, repo: "app", path: "threads.ts", reference: "@app/threads.ts" };
  const thread = { kind: "thread" as const, threadId: "id", title: "Threads plan", project: "demo", status: "idle" as const, reference: "borkcode:thread:id" };
  const category = { kind: "category", reference: "@thread:" };
  assert.deepEqual(pickerEntries("", [thread, file]), [category, file]);
  assert.deepEqual(pickerEntries("thr", [thread, file]), [category, thread, file]);
  assert.deepEqual(pickerEntries("notes", [thread, file]), [thread, file]);
  assert.deepEqual(pickerEntries("thread:", [thread, file]), [thread]);
  assert.deepEqual(pickerEntries("thread:none", []), []);
  assert.deepEqual(pickerEntries("", []), [category]);
  assert.equal(pickerEntries("t", Array.from({ length: 55 }, () => file)).length, 50);
});

test("choosing Threads replaces the typed token without a space, ready for a thread query", () => {
  assert.deepEqual(enterThreadMode("@", 0, 1), { text: "@thread:", caret: 8 });
  assert.deepEqual(enterThreadMode("See @thr please", 4, 8), { text: "See @thread: please", caret: 12 });
  assert.deepEqual(enterThreadMode("See @threadsq please", 4, 8), { text: "See @thread: please", caret: 12 });
  assert.deepEqual(insertMention("See @thread:notes", 4, 17, "borkcode:thread:id"), { text: "See borkcode:thread:id ", caret: 23 });
});
