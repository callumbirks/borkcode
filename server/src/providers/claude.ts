import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  query,
  type ModelInfo,
  type PermissionMode,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AccessMode, Item, ModelOption, Question } from "shared/protocol";
import { isNativeImage } from "../attachments.ts";
import {
  truncate,
  withAttachmentPaths,
  type ProviderSession,
  type SessionOptions,
  type TextRequest,
  type TurnAttachment,
} from "./types.ts";

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

/** Claude lists its default as a model named "default", which the CLI does not accept as a name. */
function modelOption(model: string | null): string | undefined {
  return model && model !== "default" ? model : undefined;
}

/** Never yields, so the Claude process starts and answers control requests without a turn. */
const noTurns: AsyncIterable<SDKUserMessage> = {
  [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
};

/**
 * Claude lists its default as a pseudo-model, "Default (recommended)", which borkcode leaves out so
 * a concrete model is always chosen. The model it resolves to is marked default instead, preferring
 * its alias (e.g. "opus") over a pinned id. Claude doesn't report default efforts, so borkcode uses
 * high, the API's default, where the model offers it.
 */
export function claudeModelOptions(models: ModelInfo[]): ModelOption[] {
  const fallback = models.find((model) => model.value === "default")?.resolvedModel;
  const listed = models.filter((model) => model.value !== "default");
  const candidates = listed.filter((model) => fallback !== undefined && model.resolvedModel === fallback);
  const preferred = candidates.find((model) => model.value !== model.resolvedModel) ?? candidates[0];
  return listed.map((model) => {
    const efforts = (model.supportsEffort && model.supportedEffortLevels) || [];
    return {
      id: model.value,
      name: model.displayName,
      isDefault: model === preferred,
      efforts,
      defaultEffort: efforts.includes("high") ? "high" : (efforts.at(-1) ?? null),
      supportsFastMode: model.supportsFastMode === true,
    };
  });
}

/**
 * Claude's fast mode (`/fast`) is the `fastMode` flag setting: the session starts with it as the
 * `settings` option and switches with `applyFlagSettings`. The SDK serves fast mode only when the
 * flag layer asks for it, and an explicit false also overrides the user's own settings files.
 */
export function claudeFastMode(fastMode: boolean): { fastMode: boolean } {
  return { fastMode };
}

export async function listClaudeModels(): Promise<ModelOption[]> {
  const claudeBinary = findClaudeBinary();
  const conversation = query({
    prompt: noTurns,
    options: {
      cwd: tmpdir(),
      persistSession: false,
      ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
    },
  });
  try {
    return claudeModelOptions(await conversation.supportedModels());
  } finally {
    conversation.close();
  }
}

export async function generateClaudeText(request: TextRequest): Promise<string> {
  const claudeBinary = findClaudeBinary();
  const abortController = new AbortController();
  request.signal.addEventListener("abort", () => abortController.abort(), { once: true });
  const model = modelOption(request.model);
  const conversation = query({
    prompt: request.prompt,
    options: {
      cwd: tmpdir(),
      abortController,
      tools: [],
      maxTurns: 1,
      persistSession: false,
      settingSources: [],
      systemPrompt: request.instructions,
      ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
      ...(model ? { model } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
    },
  });
  for await (const message of conversation) {
    if (message.type !== "result") continue;
    if (message.subtype === "success") return message.result;
    throw new Error(message.errors.join("\n") || message.subtype);
  }
  throw new Error("Claude exited without answering");
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
      .filter((block) => !isImageBlock(block))
      .map((block) =>
        block && typeof block === "object" && "text" in block ? String(block.text) : "[non-text output]",
      )
      .join("\n");
  }
  return "";
}

function isImageBlock(block: unknown): boolean {
  return !!block && typeof block === "object" && "type" in block && block.type === "image";
}

/**
 * The image file a tool result showed the agent: Read returns an image file's contents as an
 * image block. Images from other tools, such as an MCP screenshot, have no file to show.
 */
export function viewedImage(name: string, input: Record<string, unknown>, content: unknown): string | undefined {
  if (name !== "Read" || typeof input.file_path !== "string") return undefined;
  return Array.isArray(content) && content.some(isImageBlock) ? input.file_path : undefined;
}

/** Reads AskUserQuestion's input, skipping anything malformed rather than failing the tool call. */
export function claudeQuestions(input: Record<string, unknown>): Question[] {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  if (!Array.isArray(input.questions)) return [];
  return input.questions.flatMap((entry: unknown, index): Question[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const question = text(record.question);
    if (!question) return [];
    const options = Array.isArray(record.options) ? (record.options as unknown[]) : [];
    return [
      {
        header: text(record.header) || `Question ${index + 1}`,
        question,
        options: options.flatMap((option) => {
          if (!option || typeof option !== "object") return [];
          const { label, description } = option as Record<string, unknown>;
          return text(label) ? [{ label: text(label), description: text(description) }] : [];
        }),
        multiSelect: record.multiSelect === true,
      },
    ];
  });
}

/** AskUserQuestion takes answers keyed by question text, with several picks joined by commas. */
export function claudeAnswers(questions: Question[], answers: string[][]): Record<string, string> {
  return Object.fromEntries(questions.map((question, index) => [question.question, (answers[index] ?? []).join(", ")]));
}

const QUESTION_TOOL = "AskUserQuestion";

type ClaudeContent = SDKUserMessage["message"]["content"];
type ClaudeImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** An attachment with its bytes in base64 when it goes to Claude as an image, else null. */
export type LoadedAttachment = TurnAttachment & { base64: string | null };

/**
 * A user message: plain text, or with attachments, base64 image blocks followed by the text, which
 * also names every attachment's path for Claude's tools.
 */
export function claudeContent(text: string, attachments: LoadedAttachment[]): ClaudeContent {
  if (attachments.length === 0) return text;
  return [
    ...attachments.flatMap((attachment) =>
      attachment.base64 === null
        ? []
        : [
            {
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: attachment.mimeType as ClaudeImageType,
                data: attachment.base64,
              },
            },
          ],
    ),
    { type: "text" as const, text: withAttachmentPaths(text, attachments) },
  ];
}

async function userMessage(text: string, attachments: TurnAttachment[]): Promise<SDKUserMessage> {
  const loaded = await Promise.all(
    attachments.map(async (attachment) => ({
      ...attachment,
      base64: isNativeImage(attachment.mimeType) ? (await readFile(attachment.path)).toString("base64") : null,
    })),
  );
  return { type: "user", message: { role: "user", content: claudeContent(text, loaded) }, parent_tool_use_id: null };
}

// Ask mode lets Claude approve workspace edits; unresolved actions still reach canUseTool.
function permissionMode(accessMode: AccessMode): PermissionMode {
  return accessMode === "full" ? "bypassPermissions" : "acceptEdits";
}

export async function startClaudeSession(options: SessionOptions): Promise<ProviderSession> {
  const { events } = options;
  const turns = new TurnQueue();
  const claudeBinary = findClaudeBinary();
  const model = modelOption(options.model);
  // Starting in bypass mode would make the SDK warn that canUseTool is shadowed, but canUseTool is
  // needed once the thread switches to ask mode. So every session starts asking, and the first turn
  // switches to full access.
  let current = { model: options.model, effort: options.effort, accessMode: "ask" as AccessMode, fastMode: options.fastMode };

  const conversation = query({
    prompt: turns,
    options: {
      cwd: options.cwd,
      additionalDirectories: options.writableRoots,
      ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
      permissionMode: permissionMode("ask"),
      // Only permits bypassing; set even in ask mode so the thread can switch to full access later.
      allowDangerouslySkipPermissions: true,
      mcpServers: { borkcode: { type: "http", url: options.mcpUrl } },
      // AskUserQuestion reaches this in every permission mode, since only the user can answer it.
      canUseTool: async (toolName, input, { toolUseID }) => {
        // borkcode's own tools ask the user themselves when they need to.
        if (toolName.startsWith("mcp__borkcode__")) return { behavior: "allow", updatedInput: input };
        if (toolName === QUESTION_TOOL) {
          const questions = claudeQuestions(input);
          if (questions.length === 0) return { behavior: "deny", message: "The questions could not be read." };
          const answers = await events.question(toolUseID, questions);
          return answers
            ? { behavior: "allow", updatedInput: { ...input, answers: claudeAnswers(questions, answers) } }
            : { behavior: "deny", message: "The user did not answer; the turn was stopped." };
        }
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
      ...(model ? { model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      settings: claudeFastMode(options.fastMode),
    },
  });

  let turnActive = false;
  let interruptRequested = false;
  /** Why the Claude process is gone, so a turn sent afterwards fails instead of waiting forever. */
  let exited: string | null = null;
  let knownSessionId: string | null = null;
  // Streamed blocks get an item when they start; the complete assistant message that follows
  // fills the oldest open item of the same kind.
  const streamedBlocks = new Map<number, string>();
  const openText: string[] = [];
  const openThinking: string[] = [];
  const tools = new Map<string, { item: Extract<Item, { kind: "tool" }>; input: Record<string, unknown> }>();

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
          } else if (block.type === "tool_use" && block.name !== QUESTION_TOOL) {
            // The question's own item stands for it in the transcript.
            const item: Extract<Item, { kind: "tool" }> = {
              id: block.id,
              kind: "tool",
              name: block.name,
              summary: summarizeToolInput(block.name, block.input as Record<string, unknown>),
              output: null,
              status: "running",
            };
            tools.set(block.id, { item, input: block.input as Record<string, unknown> });
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
          const image = viewedImage(tool.item.name, tool.input, block.content);
          const output = toolResultText(block.content);
          events.item({
            ...tool.item,
            output: image && !output ? null : truncate(output),
            status: block.is_error ? "failed" : "done",
            ...(image ? { image } : {}),
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
      exited = "Claude exited unexpectedly";
    } catch (error) {
      exited = error instanceof Error ? error.message : String(error);
    } finally {
      exited ??= "Claude exited unexpectedly";
      endTurn({ status: "failed", error: exited });
      events.closed();
    }
  })();

  return {
    async sendTurn(text, settings, attachments) {
      const message = await userMessage(text, attachments);
      if (settings.model !== current.model) await conversation.setModel(modelOption(settings.model));
      // A null effort level resets to the model's default.
      if (settings.effort !== current.effort) {
        await conversation.applyFlagSettings({ effortLevel: settings.effort });
      }
      if (settings.fastMode !== current.fastMode) await conversation.applyFlagSettings(claudeFastMode(settings.fastMode));
      if (settings.accessMode !== current.accessMode) {
        await conversation.setPermissionMode(permissionMode(settings.accessMode));
      }
      current = settings;
      // The process can die before the first turn, e.g. a missing or broken binary.
      if (exited !== null) throw new Error(exited);
      turnActive = true;
      turns.push(message);
    },
    async steer(text, attachments) {
      // "next" lands at the next step boundary without aborting tools ("now" aborts them). It is
      // only certain to join this turn while a tool call is running: during the final response it
      // could start a turn of its own, which this adapter would not be tracking.
      if (!turnActive || tools.size === 0) return false;
      const message = await userMessage(text, attachments);
      // Reading the images took a moment, in which the tool call may have finished.
      if (!turnActive || tools.size === 0) return false;
      turns.push({ ...message, priority: "next" });
      return true;
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
