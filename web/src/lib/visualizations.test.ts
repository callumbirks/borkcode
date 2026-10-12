import assert from "node:assert/strict";
import { test } from "node:test";
import { FRAME_HEIGHT, reportedHeight, visualizationUrl } from "./visualizations.ts";

test("only a finite reported height gets through, clamped to the frame's bounds", () => {
  assert.equal(reportedHeight({ borkcodeHeight: 300.2 }), 301);
  assert.equal(reportedHeight({ borkcodeHeight: 5 }), FRAME_HEIGHT.min);
  assert.equal(reportedHeight({ borkcodeHeight: 1e9 }), FRAME_HEIGHT.max);
  for (const data of [null, "300", 300, {}, { borkcodeHeight: "300" }, { borkcodeHeight: NaN }, { borkcodeHeight: Infinity }]) {
    assert.equal(reportedHeight(data), null);
  }
});

test("a replaced visualization gets a new URL", () => {
  assert.notEqual(visualizationUrl("t", "v", 1), visualizationUrl("t", "v", 2));
  assert.equal(visualizationUrl("t", "v", 1), "/api/threads/t/visualizations/v?v=1");
});
