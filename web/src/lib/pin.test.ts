import assert from "node:assert/strict";
import { test } from "node:test";
import { BottomPin } from "./pin.ts";

const at = (scrollTop: number, scrollHeight = 2000, clientHeight = 500) => ({ scrollTop, scrollHeight, clientHeight });

/** A pin at the bottom of a 2000px transcript in a 500px view, with a clock in milliseconds. */
function pinned() {
  const pin = new BottomPin();
  pin.resized(at(0));
  pin.scrolled(at(1500), 0);
  return pin;
}

test("growth follows to the bottom while pinned", () => {
  const pin = pinned();
  assert.equal(pin.resized(at(1500, 2600)), 2100);
});

test("the browser moving scrollTop on its own never unpins", () => {
  const pin = pinned();
  // The scroller grows (keyboard closing, composer emptying) and scrollTop is clamped.
  pin.scrolled(at(1300, 2000, 700), 1000);
  assert.equal(pin.pinned, true);
  // Content above the view is re-measured, and anchoring moves the view up while content below grows.
  pin.scrolled(at(1250, 2200, 700), 2000);
  assert.equal(pin.pinned, true);
  assert.equal(pin.resized(at(1250, 2200, 700)), 1500);
});

test("the range shrinking under a user's scroll does not unpin while at the bottom", () => {
  const pin = pinned();
  pin.input(1000);
  pin.scrolled(at(1499, 1999), 1010);
  assert.equal(pin.pinned, true);
});

test("a shrinking scroller (keyboard opening, composer growing) stays at the bottom", () => {
  const pin = pinned();
  assert.equal(pin.resized(at(1500, 2000, 250)), 1750);
});

test("rubber-banding past the bottom does not unpin", () => {
  const pin = pinned();
  pin.hold();
  pin.scrolled(at(1540), 1000);
  pin.release(at(1540), 1020);
  pin.scrolled(at(1520), 1040);
  pin.scrolled(at(1500), 1060);
  assert.equal(pin.pinned, true);
});

test("a tap on the transcript at the bottom re-pins when the finger lifts", () => {
  const pin = pinned();
  pin.hold();
  assert.equal(pin.resized(at(1500, 2100)), null);
  pin.release(at(1500, 2100), 1000);
  assert.equal(pin.pinned, true);
  assert.equal(pin.resized(at(1500, 2100)), 1600);
});

test("scrolling up unpins and stays unpinned, including momentum after the finger lifts", () => {
  const pin = pinned();
  pin.hold();
  pin.scrolled(at(1480), 1000);
  pin.release(at(1480), 1016);
  assert.equal(pin.pinned, false);
  for (let i = 1; i <= 20; i++) pin.scrolled(at(1480 - i * 10), 1016 + i * 16);
  assert.equal(pin.resized(at(1280, 2400)), null);
  assert.equal(pin.pinned, false);
});

test("a wheel or key scrolling up unpins before the scroll lands, and its animation is the user's", () => {
  const pin = pinned();
  pin.intendUp(1000);
  assert.equal(pin.resized(at(1500, 2400)), null);
  for (let i = 1; i <= 10; i++) pin.scrolled(at(1500 - i * 50), 1000 + i * 16);
  assert.equal(pin.pinned, false);
});

test("returning to the bottom re-pins, by wheel or touch", () => {
  const pin = pinned();
  pin.intendUp(1000);
  pin.scrolled(at(900), 1016);
  assert.equal(pin.pinned, false);
  pin.input(2000);
  pin.scrolled(at(1450), 2016);
  assert.equal(pin.pinned, true);

  pin.hold();
  pin.scrolled(at(800), 3000);
  pin.scrolled(at(1300), 3016);
  assert.equal(pin.pinned, false, "not while the finger is down");
  pin.scrolled(at(1490), 3032);
  pin.release(at(1490), 3048);
  assert.equal(pin.pinned, true);
});

test("lifting a finger far from the bottom keeps it unpinned", () => {
  const pin = pinned();
  pin.hold();
  pin.scrolled(at(600), 1000);
  pin.scrolled(at(700), 1016);
  pin.release(at(700), 1032);
  assert.equal(pin.pinned, false);
});

test("content arriving under a drag up does not pull it back", () => {
  const pin = pinned();
  pin.hold();
  pin.scrolled(at(1400), 1000);
  pin.scrolled(at(1200), 1016);
  assert.equal(pin.resized(at(1200, 2300)), null);
  pin.release(at(1200, 2300), 1032);
  assert.equal(pin.pinned, false);
});

test("sending follows to the bottom from anywhere", () => {
  const pin = pinned();
  pin.intendUp(1000);
  pin.scrolled(at(300), 1016);
  assert.equal(pin.follow(at(300, 2100)), 1600);
  pin.scrolled(at(1600, 2100), 1032);
  assert.equal(pin.pinned, true);
  assert.equal(pin.resized(at(1600, 2500)), 2000);
});

test("what moves right after a tap or click is not the user's", () => {
  const pin = pinned();
  pin.hold();
  pin.release(at(1500), 1000);
  // Focusing the clicked message, or layout after it expands, moves the view.
  pin.scrolled(at(1400, 2200), 1010);
  assert.equal(pin.pinned, true);
  assert.equal(pin.resized(at(1400, 2200)), 1700);
});
