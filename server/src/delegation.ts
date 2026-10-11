import type { DelegationLimits, LinkedPullRequest } from "shared/protocol";
import type { TurnOutcome } from "./providers/types.ts";

// Text that one thread's agent receives from another, and the limits on how often threads may
// wake each other. Kept apart from ThreadService so the wording and the rules are easy to see.

/**
 * Why delivering another automatic wake-up would break a limit, or null if it is fine.
 * `wakes` are this thread's recent automatic wake-up times; `familyWakes` counts wake-ups across
 * the thread's whole tree since the user last messaged any thread in it.
 */
export function limitReached(
  wakes: number[],
  familyWakes: number,
  now: number,
  limits: DelegationLimits,
): string | null {
  const windowMs = limits.windowMinutes * 60_000;
  const recent = wakes.filter((time) => now - time < windowMs).length;
  if (recent >= limits.wakesPerWindow) {
    return `it was woken ${recent} times in ${limits.windowMinutes} minutes by other threads`;
  }
  if (familyWakes >= limits.maxAutomaticTurns) {
    return `its threads took ${familyWakes} automatic turns since you last messaged them`;
  }
  return null;
}

export function parentMessage(parentTitle: string, text: string): string {
  return [
    `Message from your parent thread "${parentTitle}", which started you.`,
    "When you have done what it asks, or need its decision, end your turn with a reply written for it: your final reply is sent to it.",
    "",
    text,
  ].join("\n");
}

export function userMessage(text: string): string {
  return `Message from the user:\n\n${text}`;
}

export function report(
  child: { id: string; title: string },
  outcome: TurnOutcome,
  reply: string | null,
  pullRequests: LinkedPullRequest[],
  userJoined: boolean,
): string {
  const ending =
    outcome.status === "failed" ? `Its turn failed: ${outcome.error}` : "Its turn finished.";
  return [
    `Report from thread "${child.title}" (id ${child.id}), which you started. ${ending}`,
    ...(userJoined ? ["The user messaged it directly during this turn."] : []),
    ...(pullRequests.length > 0
      ? ["Pull requests:", ...pullRequests.map((pr) => `- ${pr.repo} #${pr.number} ${pr.state}: ${pr.url}`)]
      : []),
    "",
    reply?.trim() ? reply.trim() : "(It ended without a reply.)",
  ].join("\n");
}

/** Several waiting messages become one turn, so the agent sees everything that arrived. */
export function combine(texts: string[]): string {
  return texts.length === 1 ? texts[0]! : texts.join("\n\n---\n\n");
}

const STATE_CHANGES: Record<string, string> = { MERGED: "was merged", CLOSED: "was closed", OPEN: "was reopened" };

/**
 * Opens a turn when pull requests changed state since the agent's last turn, such as the user
 * merging one on GitHub. `thread` names the child a pull request belongs to; null for the agent's own.
 */
export function pullRequestNotice(changes: { pr: LinkedPullRequest; thread: string | null }[]): string | null {
  if (changes.length === 0) return null;
  const lines = changes.map(({ pr, thread }) =>
    [
      `${pr.repo}#${pr.number}`,
      ...(thread ? [`(thread "${thread}")`] : []),
      STATE_CHANGES[pr.state] ?? `is now ${pr.state.toLowerCase()}`,
    ].join(" "),
  );
  return `Since your last turn: ${lines.join("; ")}.`;
}
