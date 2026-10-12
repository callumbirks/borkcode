import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUuid } from "./browser.ts";

test("draft ids are version 4 UUIDs, which the server accepts as ids", () => {
  const ids = new Set(Array.from({ length: 100 }, randomUuid));
  assert.equal(ids.size, 100);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
