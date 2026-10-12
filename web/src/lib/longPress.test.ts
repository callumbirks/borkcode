import assert from "node:assert/strict";
import { test } from "node:test";
import { LongPress } from "./longPress.ts";

/** A long press whose timer runs only when the test says so. */
function pressed() {
  const presses: { x: number; y: number }[] = [];
  let pending: (() => void) | null = null;
  const press = new LongPress(
    (x, y) => presses.push({ x, y }),
    (run) => (pending = run),
    () => (pending = null),
  );
  return { press, presses, elapse: () => pending?.() };
}

test("holding still opens at the touch, and the following click is swallowed", () => {
  const { press, presses, elapse } = pressed();
  press.start(40, 50);
  press.move(44, 53);
  elapse();
  assert.deepEqual(presses, [{ x: 40, y: 50 }]);
  assert.equal(press.end(), true);
});

test("lifting early is a tap", () => {
  const { press, presses, elapse } = pressed();
  press.start(40, 50);
  assert.equal(press.end(), false);
  elapse();
  assert.deepEqual(presses, []);
});

test("moving the finger, as when scrolling, cancels the press", () => {
  const { press, presses, elapse } = pressed();
  press.start(40, 50);
  press.move(40, 80);
  elapse();
  assert.deepEqual(presses, []);
  assert.equal(press.end(), false);
});

test("a fired press does not leak into the next tap", () => {
  const { press, elapse } = pressed();
  press.start(0, 0);
  elapse();
  press.end();
  press.start(0, 0);
  assert.equal(press.end(), false);
});
