import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item, TurnWindow } from "shared/protocol";
import { prependOlder, upsertItem } from "./transcript.ts";

const note = (id: string, text = id): Item => ({ id, kind: "notice", level: "info", text });
const ids = (window: TurnWindow) => window.items.map((item) => item.id);

test("an upsert updates a held item in place and adds a new one at the end", () => {
  const window: TurnWindow = { items: [note("a"), note("b")], from: 10 };
  upsertItem(window, note("a", "changed"), 10);
  upsertItem(window, note("c"), 12);
  assert.deepEqual(ids(window), ["a", "b", "c"]);
  assert.deepEqual(window.items[0], note("a", "changed"));
});

test("an upsert for an item in a turn that isn't loaded is left for that turn to bring", () => {
  const window: TurnWindow = { items: [note("a")], from: 10 };
  upsertItem(window, note("old"), 4);
  assert.deepEqual(ids(window), ["a"]);
  // With every turn loaded, nothing is older than the window.
  const whole: TurnWindow = { items: [note("a")], from: 0 };
  upsertItem(whole, note("b"), 0);
  assert.deepEqual(ids(whole), ["a", "b"]);
});

test("a moved item goes to the end whether or not it was loaded", () => {
  const window: TurnWindow = { items: [note("a"), note("viz"), note("b")], from: 10 };
  upsertItem(window, note("viz", "v2"), 20, true);
  assert.deepEqual(ids(window), ["a", "b", "viz"]);
  upsertItem(window, note("far"), 21, true);
  assert.deepEqual(ids(window), ["a", "b", "viz", "far"]);
});

test("older turns go before the held ones, without repeating an item moved to the end meanwhile", () => {
  const window: TurnWindow = { items: [note("c"), note("moved")], from: 10 };
  prependOlder(window, { items: [note("a"), note("moved"), note("b")], from: 0 });
  assert.deepEqual(ids(window), ["a", "b", "c", "moved"]);
  assert.equal(window.from, 0);
});
