import type { Question } from "shared/protocol";

/** A number key picks an option: single-select replaces the pick, multi-select toggles it. */
export function pick(question: Question, picked: number[], index: number): number[] {
  if (index < 0 || index >= question.options.length) return picked;
  if (!question.multiSelect) return [index];
  return picked.includes(index) ? picked.filter((other) => other !== index) : [...picked, index].sort((a, b) => a - b);
}

/**
 * The answer sent for one question. Typed text replaces a single pick and adds to multiple picks.
 * Empty means the question is not answered yet.
 */
export function answer(question: Question, picked: number[], typed: string): string[] {
  const text = typed.trim();
  if (text && !question.multiSelect) return [text];
  const labels = picked.flatMap((index) => question.options[index]?.label ?? []);
  return text ? [...labels, text] : labels;
}
