import assert from "node:assert/strict";
import { test } from "node:test";
import { BottomPin } from "./pin.ts";

const at = (scrollTop: number, scrollHeight = 2000, clientHeight = 500) => ({ scrollTop, scrollHeight, clientHeight });

test("growth follows to the bottom while pinned", () => {
  const pin = new BottomPin();
  assert.equal(pin.resized(at(0, 2000)), 1500);
  pin.scrolled(at(1500, 2000));
  assert.equal(pin.resized(at(1500, 2600)), 2100);
});

test("a growing scroller clamping scrollTop does not unpin", () => {
  const pin = new BottomPin();
  pin.resized(at(0, 2000, 300));
  pin.scrolled(at(1700, 2000, 300));
  // The keyboard closes or the composer shrinks: the browser clamps scrollTop to the new range.
  assert.equal(pin.resized(at(1500, 2000, 500)), 1500);
  pin.scrolled(at(1500, 2000, 500));
  assert.equal(pin.pinned, true);
});

test("a shrinking scroller (keyboard opening, composer growing) stays at the bottom", () => {
  const pin = new BottomPin();
  pin.resized(at(0));
  pin.scrolled(at(1500));
  assert.equal(pin.resized(at(1500, 2000, 250)), 1750);
});

test("rubber-banding past the bottom does not unpin", () => {
  const pin = new BottomPin();
  pin.resized(at(0));
  pin.scrolled(at(1500));
  pin.touchStart();
  pin.scrolled(at(1540));
  pin.touchEnd(at(1540));
  pin.scrolled(at(1520));
  pin.scrolled(at(1500));
  assert.equal(pin.pinned, true);
});

test("a tap on the transcript at the bottom re-pins when the finger lifts", () => {
  const pin = new BottomPin();
  pin.resized(at(0));
  pin.scrolled(at(1500));
  pin.touchStart();
  assert.equal(pin.resized(at(1500, 2100)), null);
  pin.touchEnd(at(1500, 2100));
  assert.equal(pin.pinned, true);
  assert.equal(pin.resized(at(1500, 2100)), 1600);
});

test("scrolling up unpins and stays unpinned, including upward momentum near the bottom", () => {
  const pin = new BottomPin();
  pin.resized(at(0));
  pin.scrolled(at(1500));
  pin.touchStart();
  pin.scrolled(at(1480));
  pin.touchEnd(at(1480));
  assert.equal(pin.pinned, false);
  pin.scrolled(at(1460));
  assert.equal(pin.resized(at(1460, 2400)), null);
  assert.equal(pin.pinned, false);
});

test("returning to the bottom re-pins, by touch or wheel", () => {
  const pin = new BottomPin();
  pin.resized(at(0));
  pin.scrolled(at(1500));
  pin.wheel(-10);
  pin.scrolled(at(900));
  assert.equal(pin.pinned, false);
  pin.scrolled(at(1450));
  assert.equal(pin.pinned, true);

  pin.touchStart();
  pin.scrolled(at(800));
  pin.scrolled(at(1300));
  assert.equal(pin.pinned, false, "not while the finger is down");
  pin.scrolled(at(1490));
  pin.touchEnd(at(1490));
  assert.equal(pin.pinned, true);
});

test("lifting a finger far from the bottom keeps it unpinned", () => {
  const pin = new BottomPin();
  pin.resized(at(0));
  pin.scrolled(at(1500));
  pin.touchStart();
  pin.scrolled(at(600));
  pin.scrolled(at(700));
  pin.touchEnd(at(700));
  assert.equal(pin.pinned, false);
});
