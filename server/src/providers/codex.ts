import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import type { AccessMode, Item, ModelOption, Question } from "shared/protocol";
import {
  isEffort,
  truncate,
  type ProviderSession,
  type SessionOptions,
  type TextRequest,
} from "./types.ts";

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

interface CodexModel {
  model: string;
  displayName: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts: { reasoningEffort: string }[];
  defaultReasoningEffort: string;
}

/** `item/tool/requestUserInput`, which the request_user_input tool sends. */
interface CodexUserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string }[] | null;
}

type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
};

class RpcError extends Error {}

type ConnectionHandlers = {
  notification: (method: string, params: Record<string, unknown>) => void;
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  exit: (detail: string) => void;
};

class AppServerConnection {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #nextId = 1;
  #stderr = "";

  constructor(cwd: string, handlers: ConnectionHandlers) {
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

async function connect(cwd: string, handlers: ConnectionHandlers): Promise<AppServerConnection> {
  const connection = new AppServerConnection(cwd, handlers);
  try {
    await connection.request("initialize", {
      clientInfo: { name: "borkcode", title: "borkcode", version: "0.1.0" },
      capabilities: null,
    });
  } catch (error) {
    connection.close();
    throw error;
  }
  connection.notify("initialized");
  return connection;
}

const noRequests = async (method: string) => {
  throw new Error(`borkcode does not support ${method} here`);
};

export async function listCodexModels(): Promise<ModelOption[]> {
  const connection = await connect(tmpdir(), { notification() {}, request: noRequests, exit() {} });
  try {
    const models: CodexModel[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: CodexModel[]; nextCursor: string | null } = await connection.request("model/list", {
        cursor,
      });
      models.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return models
      .filter((model) => !model.hidden)
      .map((model) => ({
        id: model.model,
        name: model.displayName,
        isDefault: model.isDefault,
        efforts: model.supportedReasoningEfforts.map((option) => option.reasoningEffort).filter(isEffort),
        defaultEffort: isEffort(model.defaultReasoningEffort) ? model.defaultReasoningEffort : null,
      }));
  } finally {
    connection.close();
  }
}

export async function generateCodexText(request: TextRequest): Promise<string> {
  let settle!: { resolve: (text: string) => void; reject: (error: Error) => void };
  const answer = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Failures also surface through the awaited requests below; this keeps them from going unhandled.
  answer.catch(() => {});
  const messages: string[] = [];
  const connection = await connect(tmpdir(), {
    notification(method, params) {
      if (method === "item/completed") {
        const item = params.item as CodexItem;
        if (item.type === "agentMessage") messages.push((item as Extract<CodexItem, { type: "agentMessage" }>).text);
      } else if (method === "turn/completed") {
        const turn = params.turn as CodexTurn;
        if (turn.status === "completed") settle.resolve(messages.join("\n"));
        else settle.reject(new Error(turn.error?.message ?? `Turn ${turn.status}`));
      }
    },
    request: noRequests,
    exit: (detail) => settle.reject(new Error(detail)),
  });
  const abort = () => connection.close();
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    const started = await connection.request<{ thread: { id: string } }>("thread/start", {
      cwd: tmpdir(),
      model: request.model,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: request.instructions,
    });
    await connection.request("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: request.prompt, text_elements: [] }],
      effort: request.effort,
    });
    return await answer;
  } finally {
    request.signal.removeEventListener("abort", abort);
    connection.close();
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

export function codexQuestions(questions: CodexUserInputQuestion[]): Question[] {
  return questions.map((question) => ({
    header: question.header,
    question: question.question,
    options: question.options ?? [],
    multiSelect: false,
  }));
}

/** Codex takes answers keyed by question id. */
export function codexAnswers(questions: CodexUserInputQuestion[], answers: string[][]) {
  return Object.fromEntries(questions.map((question, index) => [question.id, { answers: answers[index] ?? [] }]));
}

function approvalPolicy(accessMode: AccessMode) {
  return accessMode === "full" ? "never" : "on-request";
}

/** The turn-level equivalent of thread/start's `sandbox` and writable-roots config. */
function sandboxPolicy(accessMode: AccessMode, writableRoots: string[]) {
  return accessMode === "full"
    ? { type: "dangerFullAccess" }
    : { type: "workspaceWrite", writableRoots, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

export async function startCodexSession(options: SessionOptions): Promise<ProviderSession> {
  const { events } = options;
  const full = options.accessMode === "full";
  let currentAccess = options.accessMode;
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

  const connection = await connect(options.cwd, {
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
      if (method === "item/tool/requestUserInput") {
        const questions = params.questions as CodexUserInputQuestion[];
        const answers = await events.question(params.itemId as string, codexQuestions(questions));
        // Unanswered questions get empty answers; the turn is stopping anyway.
        return { answers: codexAnswers(questions, answers ?? questions.map(() => [])) };
      }
      // borkcode's own tools ask the user themselves when they need to.
      if (method === "mcpServer/elicitation/request" && params.serverName === "borkcode") {
        return { action: "accept", content: {}, _meta: null };
      }
      throw new Error(`borkcode does not support ${method} yet`);
    },
    exit(detail) {
      endTurn({ status: "failed", error: detail });
      events.closed();
    },
  });

  const threadParams = {
    cwd: options.cwd,
    model: options.model,
    approvalPolicy: approvalPolicy(options.accessMode),
    sandbox: full ? "danger-full-access" : "workspace-write",
    developerInstructions: options.instructions,
    config: {
      "sandbox_workspace_write.writable_roots": options.writableRoots,
      "mcp_servers.borkcode.url": options.mcpUrl,
      // Publishing waits for the user's approval, which can outlast the default timeout.
      "mcp_servers.borkcode.tool_timeout_sec": 3600,
      // Codex offers request_user_input only in plan mode unless this is on.
      "features.default_mode_request_user_input": true,
    },
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
    async sendTurn(text, settings) {
      turnActive = true;
      try {
        // Overrides stick for later turns, and null means "no change" rather than "default".
        const switchAccess = settings.accessMode !== currentAccess;
        const response = await connection.request<{ turn: CodexTurn }>("turn/start", {
          threadId,
          input: [{ type: "text", text, text_elements: [] }],
          model: settings.model,
          effort: settings.effort,
          approvalPolicy: switchAccess ? approvalPolicy(settings.accessMode) : null,
          sandboxPolicy: switchAccess ? sandboxPolicy(settings.accessMode, options.writableRoots) : null,
        });
        currentAccess = settings.accessMode;
        turnId ??= response.turn.id;
      } catch (error) {
        endTurn({ status: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    },
    async steer(text) {
      if (!turnActive || turnId === null) return false;
      // Pinned to the running turn, so a turn that just ended fails cleanly instead of starting one.
      return connection
        .request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text, text_elements: [] }] })
        .then(
          () => true,
          () => false,
        );
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
