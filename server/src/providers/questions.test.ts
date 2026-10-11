import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeAnswers, claudeQuestions } from "./claude.ts";
import { codexAnswers, codexQuestions } from "./codex.ts";

test("Claude's AskUserQuestion input maps to questions, skipping what is malformed", () => {
  const questions = claudeQuestions({
    questions: [
      {
        header: " Scope ",
        question: "Which parts?",
        multiSelect: true,
        options: [{ label: "Server", description: "The Node side" }, { label: "" }, "junk", { label: "Web" }],
      },
      { header: "", question: "Anything else?", options: [] },
      { header: "Empty", question: "  " },
    ],
  });
  assert.deepEqual(questions, [
    {
      header: "Scope",
      question: "Which parts?",
      options: [
        { label: "Server", description: "The Node side" },
        { label: "Web", description: "" },
      ],
      multiSelect: true,
    },
    { header: "Question 2", question: "Anything else?", options: [], multiSelect: false },
  ]);
  assert.deepEqual(claudeQuestions({}), []);
});

test("answers go back to Claude keyed by question text, several picks joined", () => {
  const questions = claudeQuestions({
    questions: [
      { header: "A", question: "Which parts?", multiSelect: true, options: [] },
      { header: "B", question: "Why?", options: [] },
    ],
  });
  assert.deepEqual(claudeAnswers(questions, [["Server", "Web"], ["because"]]), {
    "Which parts?": "Server, Web",
    "Why?": "because",
  });
});

test("Codex questions map over and answers go back keyed by question id", () => {
  const native = [
    { id: "scope", header: "Scope", question: "Which part?", options: [{ label: "Server", description: "Node" }] },
    { id: "why", header: "Why", question: "Why?", options: null },
  ];
  assert.deepEqual(codexQuestions(native), [
    { header: "Scope", question: "Which part?", options: [{ label: "Server", description: "Node" }], multiSelect: false },
    { header: "Why", question: "Why?", options: [], multiSelect: false },
  ]);
  assert.deepEqual(codexAnswers(native, [["Server"], ["it is faster"]]), {
    scope: { answers: ["Server"] },
    why: { answers: ["it is faster"] },
  });
});
