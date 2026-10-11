import assert from "node:assert/strict";
import { test } from "node:test";
import type { Question } from "shared/protocol";
import { answer, pick } from "./questions.ts";

const options = [
  { label: "Tests", description: "" },
  { label: "Docs", description: "" },
  { label: "Both", description: "" },
];
const single: Question = { header: "Next", question: "What next?", options, multiSelect: false };
const multi: Question = { ...single, multiSelect: true };

test("a number picks one option, or toggles it when several may be picked", () => {
  assert.deepEqual(pick(single, [0], 2), [2]);
  assert.deepEqual(pick(single, [], 5), []);
  assert.deepEqual(pick(multi, [2], 0), [0, 2]);
  assert.deepEqual(pick(multi, [0, 2], 0), [2]);
});

test("typed text replaces a single pick and adds to multiple picks", () => {
  assert.deepEqual(answer(single, [1], ""), ["Docs"]);
  assert.deepEqual(answer(single, [1], "  neither  "), ["neither"]);
  assert.deepEqual(answer(multi, [0, 1], "a changelog"), ["Tests", "Docs", "a changelog"]);
  assert.deepEqual(answer(multi, [], " "), []);
});
