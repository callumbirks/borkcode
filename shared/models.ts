// Model choices are always shown and sent as a concrete model and effort. Threads and settings
// saved before that may still hold null (the provider's default), resolved here on both sides.
import type { ModelChoice, ModelOption } from "./protocol.ts";

/**
 * The listed model a choice names. Null means the provider's default, and so does "default", the
 * pseudo-model Claude lists and older threads and settings may still name. Undefined when the
 * provider no longer lists the model.
 */
export function findModel(list: ModelOption[], model: string | null): ModelOption | undefined {
  if (model !== null && model !== "default") return list.find((option) => option.id === model);
  return list.find((option) => option.isDefault) ?? list[0];
}

/**
 * Names the model and effort a choice stands for: the default model for null, and the model's
 * default effort for null or an effort it lacks. Left alone when the list is unavailable or no
 * longer has the model, since the provider still decides then.
 */
export function resolveDefaults<T extends Pick<ModelChoice, "model" | "effort">>(choice: T, list: ModelOption[] | null): T {
  const option = list && findModel(list, choice.model);
  if (!option) return choice;
  const effort = choice.effort !== null && option.efforts.includes(choice.effort) ? choice.effort : option.defaultEffort;
  return { ...choice, model: option.id, effort };
}
