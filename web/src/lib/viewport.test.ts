import assert from "node:assert/strict";
import { test } from "node:test";
import { viewportTracker } from "./viewport.ts";

const phone = { scale: 1, layoutWidth: 430, layoutHeight: 932 };

test("iOS standalone: the keyboard shrinks only the visual viewport", () => {
  const track = viewportTracker();
  assert.deepEqual(track({ ...phone, height: 932, top: 0 }), { height: 932, top: 0, bottom: 0, keyboard: false });
  // Focusing pans the visual viewport within the unchanged layout viewport.
  assert.deepEqual(track({ ...phone, height: 526, top: 300 }), { height: 526, top: 300, bottom: 106, keyboard: true });
  assert.equal(track({ ...phone, height: 932, top: 0 }).keyboard, false);
});

test("Android resizes-content: both viewports shrink", () => {
  const track = viewportTracker();
  track({ ...phone, height: 800, top: 0, layoutHeight: 800 });
  assert.deepEqual(track({ ...phone, height: 480, top: 0, layoutHeight: 480 }), { height: 480, top: 0, bottom: 0, keyboard: true });
});

test("Safari's toolbar collapsing and pinch zoom are not a keyboard", () => {
  const track = viewportTracker();
  track({ ...phone, height: 750, top: 0, layoutHeight: 750 });
  assert.equal(track({ ...phone, height: 830, top: 0, layoutHeight: 830 }).keyboard, false);
  assert.equal(track({ ...phone, height: 415, top: 200, scale: 2 }).keyboard, false);
});

test("rotating starts over, so landscape's shorter height is not a keyboard", () => {
  const track = viewportTracker();
  track({ ...phone, height: 932, top: 0 });
  assert.equal(track({ height: 430, top: 0, scale: 1, layoutWidth: 932, layoutHeight: 430 }).keyboard, false);
  assert.equal(track({ height: 200, top: 230, scale: 1, layoutWidth: 932, layoutHeight: 430 }).keyboard, true);
});
