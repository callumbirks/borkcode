import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanTitle, fallbackTitle } from "./titles.ts";

test("fallback titles use the first line, cut at a word", () => {
  assert.equal(fallbackTitle("  Fix the login\nflow please "), "Fix the login");
  assert.equal(
    fallbackTitle("Refactor the websocket transport so that reconnects resume streaming without losing deltas"),
    "Refactor the websocket transport so that reconnects resume…",
  );
  assert.equal(fallbackTitle("   "), "New thread");
});

test("generated titles lose quotes, markdown and trailing punctuation", () => {
  assert.equal(cleanTitle('"Fix login redirect loop."'), "Fix login redirect loop");
  assert.equal(cleanTitle("\n**Title:** Add effort picker\nBecause…"), "Add effort picker");
  assert.equal(cleanTitle("# Shared project files"), "Shared project files");
  assert.equal(cleanTitle("  \n "), "");
});
