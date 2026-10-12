import type { AccessMode, Approval, Attachment, Effort, Item, Question } from "shared/protocol";
import { isNativeImage } from "../attachments.ts";

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
  /**
   * Asks the user questions, recording them as an item with this id. Resolves with one answer per
   * question, or null when the turn stopped or the session ended first.
   */
  question(id: string, questions: Question[]): Promise<string[][] | null>;
}

export interface SessionOptions {
  cwd: string;
  /** Directories outside cwd the agent may write to. */
  writableRoots: string[];
  /** Appended to the provider's own system instructions. */
  instructions: string;
  accessMode: AccessMode;
  model: string | null;
  effort: Effort | null;
  /** borkcode's MCP endpoint for this session; the agent's borkcode tools live there. */
  mcpUrl: string;
  resumeId: string | null;
  events: SessionEvents;
}

/** Null model or effort means the provider's default. */
export interface ModelSettings {
  model: string | null;
  effort: Effort | null;
}

export interface TurnSettings extends ModelSettings {
  accessMode: AccessMode;
}

/** A file sent with a message, stored on this machine at `path`. */
export interface TurnAttachment extends Attachment {
  path: string;
}

export interface ProviderSession {
  /**
   * Starts a turn, switching model, effort and access mode first if they changed. Resolves once the provider
   * accepts it; the end arrives as `turnEnded`.
   */
  sendTurn(text: string, settings: TurnSettings, attachments: TurnAttachment[]): Promise<void>;
  /**
   * Adds a message to the running turn at its next step, without interrupting a tool call.
   * Resolves false when that is not possible right now, and the caller should wait for the turn
   * to end instead.
   */
  steer(text: string, attachments: TurnAttachment[]): Promise<boolean>;
  interrupt(): Promise<void>;
  close(): void;
}

/** A single tool-less completion, used for small jobs such as naming threads. */
export interface TextRequest extends ModelSettings {
  instructions: string;
  prompt: string;
  signal: AbortSignal;
}

export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function isEffort(value: unknown): value is Effort {
  return EFFORTS.includes(value as Effort);
}

export function truncate(text: string, max = 8000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}

/**
 * Images reach the model as pixels, but its tools can only use a file by path, so every attachment
 * is also named with its path, e.g. for an agent asked to commit a screenshot. Other files reach
 * the agent only this way, with their type and size so it can choose how to read them.
 */
export function withAttachmentPaths(text: string, attachments: TurnAttachment[]): string {
  const notes = attachments.map((attachment) =>
    isNativeImage(attachment.mimeType)
      ? `[Attached image "${attachment.name}" is saved at: ${attachment.path}]`
      : `[Attached file "${attachment.name}" (${attachment.mimeType}, ${formatSize(attachment.size)}) is saved at: ${attachment.path}]`,
  );
  return [text, ...notes].filter(Boolean).join("\n\n");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
