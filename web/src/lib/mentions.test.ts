import assert from "node:assert/strict";
import { test } from "node:test";
import { insertMention, mentionAt } from "./mentions.ts";

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
