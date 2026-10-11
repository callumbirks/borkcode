import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Item } from "shared/protocol";
import { truncate, type ProviderSession, type SessionOptions } from "./types.ts";

/** Async iterable the SDK reads user turns from, keeping one Claude process alive per thread. */
class TurnQueue implements AsyncIterable<SDKUserMessage> {
  #pending: SDKUserMessage[] = [];
  #waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  #closed = false;

  push(message: SDKUserMessage): void {
    if (this.#waiting) {
      const resolve = this.#waiting;
      this.#waiting = null;
      resolve({ value: message, done: false });
    } else {
      this.#pending.push(message);
    }
  }

  close(): void {
    this.#closed = true;
    this.#waiting?.({ value: undefined, done: true });
    this.#waiting = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const next = this.#pending.shift();
        if (next) return Promise.resolve({ value: next, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
    };
  }
}

/** Uses the user's installed `claude` so it shares their login and version. */
function findClaudeBinary(): string | undefined {
  if (process.env.BORKCODE_CLAUDE_BIN) return process.env.BORKCODE_CLAUDE_BIN;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, "claude");
    if (dir && existsSync(candidate)) return candidate;
  }
  return undefined;
}

function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  const field = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : null);
  const summary =
    field("command") ??
    field("file_path") ??
    field("pattern") ??
    field("url") ??
    field("description") ??
    field("query");
  return summary ?? truncate(JSON.stringify(input), 300);
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && "text" in block ? String(block.text) : "[non-text output]",
      )
      .join("\n");
  }
  return "";
}

export async function startClaudeSession(options: SessionOptions): Promise<ProviderSession> {
  const { events } = options;
  const turns = new TurnQueue();
  const full = options.accessMode === "full";
  const claudeBinary = findClaudeBinary();

  const conversation = query({
    prompt: turns,
    options: {
      cwd: options.cwd,
      additionalDirectories: options.writableRoots,
      ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
      permissionMode: full ? "bypassPermissions" : "default",
      ...(full ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool: async (toolName, input) => {
        const allowed = await events.approval({
          title: `Allow ${toolName}?`,
          detail: summarizeToolInput(toolName, input),
        });
        return allowed
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: "The user declined this action." };
      },
      includePartialMessages: true,
      systemPrompt: { type: "preset", preset: "claude_code", append: options.instructions },
      ...(options.resumeId ? { resume: options.resumeId } : {}),
      ...(options.model ? { model: options.model } : {}),
    },
  });

  let turnActive = false;
  let interruptRequested = false;
  let knownSessionId: string | null = null;
  // Streamed blocks get an item when they start; the complete assistant message that follows
  // fills the oldest open item of the same kind.
  const streamedBlocks = new Map<number, string>();
  const openText: string[] = [];
  const openThinking: string[] = [];
  const tools = new Map<string, Extract<Item, { kind: "tool" }>>();

  const endTurn = (outcome: Parameters<typeof events.turnEnded>[0]) => {
    if (!turnActive) return;
    turnActive = false;
    interruptRequested = false;
    openText.length = 0;
    openThinking.length = 0;
    events.turnEnded(outcome);
  };

  const handle = (message: SDKMessage) => {
    if ("session_id" in message && message.session_id && message.session_id !== knownSessionId) {
      knownSessionId = message.session_id;
      events.sessionId(message.session_id);
    }
    // Subagent activity is summarized by its parent tool call.
    if ("parent_tool_use_id" in message && message.parent_tool_use_id) return;

    switch (message.type) {
      case "stream_event": {
        const event = message.event;
        if (event.type === "message_start") {
          streamedBlocks.clear();
        } else if (event.type === "content_block_start") {
          const kind = event.content_block.type;
          if (kind !== "text" && kind !== "thinking") return;
          const id = randomUUID();
          streamedBlocks.set(event.index, id);
          (kind === "text" ? openText : openThinking).push(id);
          events.item({ id, kind: kind === "text" ? "assistant" : "reasoning", text: "" });
        } else if (event.type === "content_block_delta") {
          const id = streamedBlocks.get(event.index);
          if (!id) return;
          if (event.delta.type === "text_delta") events.delta(id, event.delta.text);
          else if (event.delta.type === "thinking_delta") events.delta(id, event.delta.thinking);
        }
        return;
      }
      case "assistant": {
        for (const block of message.message.content) {
          if (block.type === "text") {
            events.item({ id: openText.shift() ?? randomUUID(), kind: "assistant", text: block.text });
          } else if (block.type === "thinking") {
            const id = openThinking.shift();
            if (id || block.thinking) {
              events.item({ id: id ?? randomUUID(), kind: "reasoning", text: block.thinking });
            }
          } else if (block.type === "tool_use") {
            const item: Extract<Item, { kind: "tool" }> = {
              id: block.id,
              kind: "tool",
              name: block.name,
              summary: summarizeToolInput(block.name, block.input as Record<string, unknown>),
              output: null,
              status: "running",
            };
            tools.set(block.id, item);
            events.item(item);
          }
        }
        return;
      }
      case "user": {
        const content = message.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          const tool = tools.get(block.tool_use_id);
          if (!tool) continue;
          tools.delete(block.tool_use_id);
          events.item({
            ...tool,
            output: truncate(toolResultText(block.content)),
            status: block.is_error ? "failed" : "done",
          });
        }
        return;
      }
      case "result": {
        if (message.subtype === "success") {
          endTurn({ status: "completed" });
        } else if (interruptRequested) {
          endTurn({ status: "interrupted" });
        } else {
          endTurn({ status: "failed", error: message.errors.join("\n") || message.subtype });
        }
        return;
      }
    }
  };

  void (async () => {
    try {
      for await (const message of conversation) handle(message);
      endTurn({ status: "failed", error: "Claude exited unexpectedly" });
    } catch (error) {
      endTurn({ status: "failed", error: error instanceof Error ? error.message : String(error) });
    } finally {
      events.closed();
    }
  })();

  return {
    async sendTurn(text) {
      turnActive = true;
      turns.push({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
      });
    },
    async interrupt() {
      if (!turnActive) return;
      interruptRequested = true;
      await conversation.interrupt();
    },
    close() {
      turns.close();
      conversation.close();
    },
  };
}
