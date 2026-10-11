import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Item } from "shared/protocol";
import { truncate, type ProviderSession, type SessionOptions } from "./types.ts";

// Minimal hand-written slice of the app-server protocol. Regenerate the full bindings with
// `codex app-server generate-ts --out <dir>` when extending this.

type ItemStatus = "inProgress" | "completed" | "failed" | "declined";

type CodexItem =
  | { type: "agentMessage"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      aggregatedOutput: string | null;
      status: ItemStatus;
    }
  | {
      type: "fileChange";
      id: string;
      changes: { path: string; diff: string }[];
      status: ItemStatus;
    }
  | {
      type: "mcpToolCall";
      id: string;
      server: string;
      tool: string;
      arguments: unknown;
      result: { content: unknown[] } | null;
      error: { message: string } | null;
      status: ItemStatus;
    }
  | { type: "webSearch"; id: string; query?: string }
  | { type: string; id?: string };

interface CodexTurn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: { message: string } | null;
}

type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
};

class RpcError extends Error {}

class AppServerConnection {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #nextId = 1;
  #stderr = "";

  constructor(
    cwd: string,
    handlers: {
      notification: (method: string, params: Record<string, unknown>) => void;
      request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
      exit: (detail: string) => void;
    },
  ) {
    this.#child = spawn(process.env.BORKCODE_CODEX_BIN ?? "codex", ["app-server"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stderr.on("data", (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString()).slice(-4000);
    });
    createInterface({ input: this.#child.stdout }).on("line", (line) => {
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        return;
      }
      if (message.method !== undefined && message.id !== undefined) {
        const id = message.id;
        handlers.request(message.method, message.params ?? {}).then(
          (result) => this.#send({ id, result }),
          (error: Error) => this.#send({ id, error: { code: -32000, message: error.message } }),
        );
      } else if (message.method !== undefined) {
        handlers.notification(message.method, message.params ?? {});
      } else if (typeof message.id === "number") {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) pending?.reject(new RpcError(message.error.message));
        else pending?.resolve(message.result);
      }
    });
    const onExit = (detail: string) => {
      for (const pending of this.#pending.values()) pending.reject(new Error(detail));
      this.#pending.clear();
      handlers.exit(detail);
    };
    this.#child.on("error", (error) => onExit(`Could not start codex: ${error.message}`));
    this.#child.on("exit", (code) => onExit(`codex app-server exited (${code})\n${this.#stderr}`.trim()));
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.#send({ id, method, params });
    });
  }

  notify(method: string): void {
    this.#send({ method });
  }

  close(): void {
    this.#child.kill();
  }

  #send(message: unknown): void {
    if (this.#child.stdin.writable) this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

function toolStatus(status: ItemStatus) {
  if (status === "completed") return "done" as const;
  if (status === "failed" || status === "declined") return "failed" as const;
  return "running" as const;
}

function mcpResultText(result: { content: unknown[] } | null): string | null {
  if (!result) return null;
  return result.content
    .map((block) =>
      block && typeof block === "object" && "text" in block ? String(block.text) : "[non-text output]",
    )
    .join("\n");
}

function toItem(item: CodexItem): Item | null {
  switch (item.type) {
    case "agentMessage": {
      const message = item as Extract<CodexItem, { type: "agentMessage" }>;
      return { id: message.id, kind: "assistant", text: message.text };
    }
    case "reasoning": {
      const reasoning = item as Extract<CodexItem, { type: "reasoning" }>;
      return { id: reasoning.id, kind: "reasoning", text: reasoning.summary.join("\n\n") };
    }
    case "commandExecution": {
      const command = item as Extract<CodexItem, { type: "commandExecution" }>;
      return {
        id: command.id,
        kind: "tool",
        name: "shell",
        summary: command.command,
        output: command.aggregatedOutput === null ? null : truncate(command.aggregatedOutput),
        status: toolStatus(command.status),
      };
    }
    case "fileChange": {
      const change = item as Extract<CodexItem, { type: "fileChange" }>;
      return {
        id: change.id,
        kind: "tool",
        name: "edit",
        summary: change.changes.map((file) => file.path).join(", "),
        output: truncate(change.changes.map((file) => file.diff).join("\n")),
        status: toolStatus(change.status),
      };
    }
    case "mcpToolCall": {
      const call = item as Extract<CodexItem, { type: "mcpToolCall" }>;
      return {
        id: call.id,
        kind: "tool",
        name: `${call.server}.${call.tool}`,
        summary: truncate(JSON.stringify(call.arguments ?? {}), 300),
        output: call.error?.message ?? mcpResultText(call.result),
        status: toolStatus(call.status),
      };
    }
    case "webSearch": {
      const search = item as Extract<CodexItem, { type: "webSearch" }>;
      return {
        id: search.id,
        kind: "tool",
        name: "web search",
        summary: search.query ?? "",
        output: null,
        status: "done",
      };
    }
    default:
      return null;
  }
}

export async function startCodexSession(options: SessionOptions): Promise<ProviderSession> {
  const { events } = options;
  const full = options.accessMode === "full";
  let threadId: string | null = null;
  let turnId: string | null = null;
  let turnActive = false;
  const fileChanges = new Map<string, string>();

  const endTurn = (outcome: Parameters<typeof events.turnEnded>[0]) => {
    if (!turnActive) return;
    turnActive = false;
    turnId = null;
    events.turnEnded(outcome);
  };

  const connection = new AppServerConnection(options.cwd, {
    notification(method, params) {
      if (threadId !== null && "threadId" in params && params.threadId !== threadId) return;
      switch (method) {
        case "item/started":
        case "item/completed": {
          const raw = params.item as CodexItem;
          if (raw.type === "fileChange") {
            const change = raw as Extract<CodexItem, { type: "fileChange" }>;
            fileChanges.set(change.id, change.changes.map((file) => file.path).join("\n"));
          }
          const item = toItem(raw);
          if (item) events.item(item);
          return;
        }
        case "item/agentMessage/delta":
        case "item/reasoning/summaryTextDelta":
          events.delta(params.itemId as string, params.delta as string);
          return;
        case "turn/started":
          turnId = (params.turn as CodexTurn).id;
          return;
        case "turn/completed": {
          const turn = params.turn as CodexTurn;
          if (turn.status === "failed") {
            endTurn({ status: "failed", error: turn.error?.message ?? "Turn failed" });
          } else {
            endTurn({ status: turn.status === "interrupted" ? "interrupted" : "completed" });
          }
          return;
        }
      }
    },
    async request(method, params) {
      if (method === "item/commandExecution/requestApproval") {
        const detail = [params.command, params.cwd && `in ${params.cwd}`, params.reason]
          .filter(Boolean)
          .join("\n");
        const allowed = await events.approval({ title: "Run command?", detail });
        return { decision: allowed ? "accept" : "decline" };
      }
      if (method === "item/fileChange/requestApproval") {
        const detail = [fileChanges.get(params.itemId as string), params.reason]
          .filter(Boolean)
          .join("\n");
        const allowed = await events.approval({ title: "Apply file changes?", detail });
        return { decision: allowed ? "accept" : "decline" };
      }
      throw new Error(`borkcode does not support ${method} yet`);
    },
    exit(detail) {
      endTurn({ status: "failed", error: detail });
      events.closed();
    },
  });

  await connection.request("initialize", {
    clientInfo: { name: "borkcode", title: "borkcode", version: "0.1.0" },
    capabilities: null,
  });
  connection.notify("initialized");

  const threadParams = {
    cwd: options.cwd,
    model: options.model,
    approvalPolicy: full ? "never" : "on-request",
    sandbox: full ? "danger-full-access" : "workspace-write",
    developerInstructions: options.instructions,
    config: { "sandbox_workspace_write.writable_roots": options.writableRoots },
  };
  let started: { thread: { id: string } } | null = null;
  if (options.resumeId) {
    started = await connection
      .request<{ thread: { id: string } }>("thread/resume", { threadId: options.resumeId, ...threadParams })
      .catch(() => null);
  }
  started ??= await connection.request<{ thread: { id: string } }>("thread/start", threadParams);
  threadId = started.thread.id;
  events.sessionId(threadId);

  return {
    async sendTurn(text) {
      turnActive = true;
      try {
        const response = await connection.request<{ turn: CodexTurn }>("turn/start", {
          threadId,
          input: [{ type: "text", text, text_elements: [] }],
        });
        turnId ??= response.turn.id;
      } catch (error) {
        endTurn({ status: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    },
    async interrupt() {
      if (!turnActive || turnId === null) return;
      await connection.request("turn/interrupt", { threadId, turnId });
    },
    close() {
      connection.close();
    },
  };
}
