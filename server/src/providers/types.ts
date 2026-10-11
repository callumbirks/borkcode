import type { AccessMode, Approval, Item } from "shared/protocol";

export type TurnOutcome = { status: "completed" | "interrupted" } | { status: "failed"; error: string };

/** Callbacks a provider session uses to report activity in its normalized form. */
export interface SessionEvents {
  /** Records the provider-native id needed to resume this conversation later. */
  sessionId(id: string): void;
  /** Adds or replaces a transcript item. */
  item(item: Item): void;
  /** Appends streamed text to an assistant or reasoning item. */
  delta(itemId: string, text: string): void;
  turnEnded(outcome: TurnOutcome): void;
  /** The provider process is gone; the next turn needs a new session. */
  closed(): void;
  /** Asks the user to approve an action. Resolves false when declined or abandoned. */
  approval(request: Omit<Approval, "id">): Promise<boolean>;
}

export interface SessionOptions {
  cwd: string;
  /** Directories outside cwd the agent may write to. */
  writableRoots: string[];
  /** Appended to the provider's own system instructions. */
  instructions: string;
  accessMode: AccessMode;
  model: string | null;
  resumeId: string | null;
  events: SessionEvents;
}

export interface ProviderSession {
  /** Starts a turn. Resolves once the provider accepts it; the end arrives as `turnEnded`. */
  sendTurn(text: string): Promise<void>;
  interrupt(): Promise<void>;
  close(): void;
}

export function truncate(text: string, max = 8000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}
