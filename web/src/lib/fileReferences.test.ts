import assert from "node:assert/strict";
import { test } from "node:test";
import { findFileReferences, labelFor, splitReferences, type ReferenceRoots } from "./fileReferences.ts";

const roots: ReferenceRoots = {
  repos: ["borkcode", "vessel"],
  workspace: "/home/me/projects/demo/worktrees/fix-a1",
  projectFiles: "/home/me/projects/demo/files",
};

test("labels are relative: from the repo name, or under Project files", () => {
  assert.equal(labelFor("borkcode/server/src/main.ts", roots), "borkcode/server/src/main.ts");
  assert.equal(labelFor("/home/me/projects/demo/files/plans/x.md", roots), "Project files/plans/x.md");
  assert.equal(labelFor("/home/me/projects/demo/worktrees/fix-a1/vessel/a.ts", roots), "vessel/a.ts");
  assert.equal(labelFor("someone", roots), null);
  assert.equal(labelFor("other/x.ts", roots), null);
  assert.equal(labelFor("borkcode/", roots), null);
  assert.equal(labelFor("/etc/passwd", roots), null);
});

test("only the forms the picker inserts, pointing at known files, are references", () => {
  const text =
    'What does @borkcode/server/src/main.ts do? See @"/home/me/projects/demo/files/my plan.md", ' +
    "ask @someone, mail me@borkcode/x.ts and check @vessel/a.ts.";
  const found = findFileReferences(text, roots);
  assert.deepEqual(
    found.map((reference) => [text.slice(reference.start, reference.end), reference.name, reference.label]),
    [
      ["@borkcode/server/src/main.ts", "main.ts", "borkcode/server/src/main.ts"],
      ['@"/home/me/projects/demo/files/my plan.md"', "my plan.md", "Project files/my plan.md"],
      ["@vessel/a.ts", "a.ts", "vessel/a.ts"],
    ],
  );
  assert.deepEqual(
    splitReferences("see @vessel/a.ts now", findFileReferences("see @vessel/a.ts now", roots)).map((part) => [
      part.text,
      part.reference?.name ?? null,
    ]),
    [
      ["see ", null],
      ["@vessel/a.ts", "a.ts"],
      [" now", null],
    ],
  );
});
