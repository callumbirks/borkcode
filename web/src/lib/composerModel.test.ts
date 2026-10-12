import assert from "node:assert/strict";
import { test } from "node:test";
import { chipBeside, coverReferences, History, insertBeside, replaceRange } from "./composerModel.ts";
import type { FileReference } from "./fileReferences.ts";

// "see @app/a.ts now": the reference spans 4..13.
const references: FileReference[] = [{ start: 4, end: 13, name: "a.ts", label: "app/a.ts" }];

test("edits treat a chip as one unit", () => {
  assert.deepEqual(chipBeside(13, true, references), [4, 13]);
  assert.deepEqual(chipBeside(4, false, references), [4, 13]);
  assert.equal(chipBeside(14, true, references), null);
  assert.deepEqual(coverReferences(2, 6, references), [2, 13]);
  assert.deepEqual(coverReferences(0, 3, references), [0, 3]);
  assert.deepEqual(replaceRange("see @app/a.ts now", 4, 13, ""), { text: "see  now", caret: 4 });
});

test("undo steps back over runs of typing as one, and redo replays them", () => {
  const history = new History();
  history.record({ text: "", caret: 0 }, { text: "h", caret: 1 }, "typing", 0);
  history.record({ text: "h", caret: 1 }, { text: "hi", caret: 2 }, "typing", 100);
  history.record({ text: "hi", caret: 2 }, { text: "hi there", caret: 8 }, "paste", 200);
  const pasted = { text: "hi there", caret: 8 };
  const beforePaste = history.undo(pasted);
  assert.deepEqual(beforePaste, { text: "hi", caret: 2 });
  assert.deepEqual(history.undo(beforePaste!), { text: "", caret: 0 });
  assert.equal(history.undo({ text: "", caret: 0 }), null);
  assert.deepEqual(history.redo({ text: "", caret: 0 }), { text: "hi", caret: 2 });
  assert.deepEqual(history.redo({ text: "hi", caret: 2 }), pasted);
});

test("typing somewhere else starts a new undo step", () => {
  const history = new History();
  history.record({ text: "ab", caret: 2 }, { text: "abZ", caret: 3 }, "typing", 0);
  history.record({ text: "abZ", caret: 0 }, { text: "YabZ", caret: 1 }, "typing", 100);
  assert.deepEqual(history.undo({ text: "YabZ", caret: 1 }), { text: "abZ", caret: 0 });
});

test("typing against a chip keeps a space between them", () => {
  const text = "see @app/a.ts now";
  assert.deepEqual(insertBeside(text, 13, 13, "X", references), { text: "see @app/a.ts X now", caret: 15 });
  assert.deepEqual(insertBeside(text, 13, 13, "?", references), { text: "see @app/a.ts? now", caret: 14 });
  assert.deepEqual(insertBeside(text, 13, 13, " ", references), { text: "see @app/a.ts  now", caret: 14 });
  assert.deepEqual(insertBeside(text, 4, 4, "Y", references), { text: "see Y @app/a.ts now", caret: 5 });
  assert.deepEqual(insertBeside(text, 1, 1, "x", references), { text: "sxee @app/a.ts now", caret: 2 });
});
