import assert from "node:assert/strict";
import { test } from "node:test";
import { limitReached } from "./delegation.ts";

const limits = { wakesPerWindow: 3, windowMinutes: 10, maxAutomaticTurns: 5 };
const minute = 60_000;

test("a thread woken too often in the window is stopped, but older wake-ups age out", () => {
  const now = 100 * minute;
  assert.equal(limitReached([now - 1 * minute, now - 2 * minute], 2, now, limits), null);
  assert.match(
    limitReached([now - 1 * minute, now - 2 * minute, now - 3 * minute], 3, now, limits) ?? "",
    /woken 3 times in 10 minutes/,
  );
  assert.equal(limitReached([now - 11 * minute, now - 12 * minute, now - 1 * minute], 3, now, limits), null);
});

test("a thread tree stops after its total of automatic turns, however slowly they came", () => {
  const now = 100 * minute;
  assert.equal(limitReached([], 4, now, limits), null);
  assert.match(limitReached([], 5, now, limits) ?? "", /5 automatic turns since you last messaged them/);
});
