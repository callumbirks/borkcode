import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  ClientMessage,
  RequestMethod,
  Requests,
  ServerEvent,
  ServerMessage,
} from "shared/protocol";
import { AttachmentError, AttachmentStore, MAX_ATTACHMENT_BYTES } from "./attachments.ts";
import { loadConfig } from "./config.ts";
import { Database } from "./db.ts";
import { FileStore } from "./files.ts";
import { handleMcpRequest } from "./mcp.ts";
import { MentionSearch } from "./mentions.ts";
import { isAllowedOrigin, isSameSiteFetch } from "./origins.ts";
import { listModels } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { SettingsStore } from "./settings.ts";
import { locateAll, PreviewError, readPreview, type PreviewRoots } from "./threadFiles.ts";
import { ThreadService } from "./threads.ts";
import { VISUALIZATION_HEADERS } from "./visualizations.ts";

const config = loadConfig();
const db = new Database(join(config.home, "state.sqlite"));
const projects = new ProjectStore(config.home);
const settings = new SettingsStore(config.home);
const clients = new Set<WebSocket>();

function broadcast(event: ServerEvent): void {
  const payload = JSON.stringify({ event } satisfies ServerMessage);
  for (const client of clients) client.send(payload);
}

const files = new FileStore(projects, (project, list) =>
  broadcast({ type: "files.changed", project, files: list }),
);
void files.watchAll().catch((error: Error) => console.error(`Could not watch project files: ${error.message}`));

// Agents connect from this machine, so a wildcard bind is reached through loopback.
const mcpHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
const threads = new ThreadService(
  db,
  projects,
  settings,
  broadcast,
  `http://${mcpHost}:${config.port}/mcp/`,
  new AttachmentStore(config.home),
);

const mentions = new MentionSearch(files, (threadId) => threads.location(threadId));

async function previewRoots(threadId: string): Promise<PreviewRoots> {
  const { project, root } = await threads.location(threadId);
  return { workspace: root, project: files.root(project.name), repos: project.repos.map((repo) => repo.name) };
}

async function projectsChanged<T>(result: T): Promise<T> {
  broadcast({ type: "projects.changed", projects: await projects.list() });
  return result;
}

type Handlers = {
  [M in RequestMethod]: (params: Requests[M]["params"]) => Promise<Requests[M]["result"]>;
};

const handlers: Handlers = {
  "projects.list": () => projects.list(),
  "projects.create": async ({ name }) => {
    const project = await projects.create(name.trim());
    files.watch(project.name);
    return projectsChanged(project);
  },
  "repos.add": async ({ project, url, name }) =>
    projectsChanged(await projects.addRepo(project, url, name)),
  "repos.update": async ({ project, name, ...patch }) =>
    projectsChanged(await projects.updateRepo(project, name, patch)),
  "files.list": ({ project }) => {
    files.watch(project);
    return files.list(project);
  },
  "files.read": ({ project, path }) => files.read(project, path),
  "files.write": ({ project, path, content, expectedModifiedAt }) =>
    files.write(project, path, content, expectedModifiedAt),
  "files.delete": async ({ project, path }) => {
    await files.delete(project, path);
    return null;
  },
  "files.deleteFolder": ({ project, path }) => files.deleteFolder(project, path),
  "mentions.search": ({ threadId, query }) => mentions.search(threadId, query),
  "threads.locateFiles": async ({ threadId, paths }) => locateAll(await previewRoots(threadId), paths),
  "threads.list": async () => threads.list(),
  "threads.create": (params) => threads.create(params),
  "threads.get": ({ threadId }) => threads.get(threadId),
  "threads.send": async ({ threadId, text, attachments, model, effort, accessMode }) => {
    // The turn runs in the background; progress arrives as events.
    void threads
      .send(threadId, text, { model, effort, accessMode }, attachments ?? [])
      .catch((error: Error) => console.error(error));
    return null;
  },
  "threads.rename": async ({ threadId, title }) => threads.rename(threadId, title),
  "threads.publish": async ({ threadId, model, effort, accessMode }) => {
    // Like threads.send, the turn runs in the background.
    void threads.publish(threadId, { model, effort, accessMode }).catch((error: Error) => console.error(error));
    return null;
  },
  "threads.resume": async ({ threadId }) => {
    // Like threads.send, any turn it starts runs in the background.
    void threads.resume(threadId).catch((error: Error) => console.error(error));
    return null;
  },
  "threads.interrupt": async ({ threadId }) => {
    await threads.interrupt(threadId);
    return null;
  },
  "threads.archive": async ({ threadId, archived }) => {
    threads.setArchived(threadId, archived);
    return null;
  },
  "threads.markRead": async ({ threadId }) => {
    threads.markRead(threadId);
    return null;
  },
  "threads.delete": async ({ threadId, force }) => {
    await threads.delete(threadId, force ?? false);
    return null;
  },
  "threads.repoStatus": ({ threadId }) => threads.repoStatus(threadId),
  "pullRequests.list": async () => threads.allPullRequests(),
  "pullRequests.refresh": async () => {
    // Changes arrive as events, so the client need not wait for GitHub.
    void threads.refreshPullRequestsOnReturn().catch((error: Error) => console.error(error));
    return null;
  },
  "approvals.respond": async ({ threadId, approvalId, allow }) => {
    threads.respondToApproval(threadId, approvalId, allow);
    return null;
  },
  "questions.answer": async ({ threadId, questionId, answers }) => {
    threads.answerQuestion(threadId, questionId, answers);
    return null;
  },
  "models.list": ({ provider }) => listModels(provider),
  "settings.get": () => settings.get(),
  "settings.update": async (params) => {
    const next = await settings.update(params.settings);
    broadcast({ type: "settings.changed", settings: next });
    return next;
  },
};

async function dispatch(message: ClientMessage): Promise<unknown> {
  const handler = handlers[message.method] as ((params: unknown) => Promise<unknown>) | undefined;
  if (!handler) throw new Error(`Unknown method ${message.method}`);
  return handler(message.params ?? {});
}

function replyError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: message }));
}

/** `POST /api/threads/<id>/attachments` stores an upload; `GET .../attachments/<id>` serves it. */
async function handleAttachments(
  request: IncomingMessage,
  response: ServerResponse,
  threadId: string,
  attachmentId: string | undefined,
): Promise<void> {
  if (!isAllowedOrigin(request) || !isSameSiteFetch(request)) return replyError(response, 403, "Forbidden");
  if (request.method === "POST" && !attachmentId) {
    if (Number(request.headers["content-length"] ?? 0) > MAX_ATTACHMENT_BYTES) {
      response.setHeader("connection", "close");
      return replyError(response, 413, `Attachments can be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
    }
    const name = decodeURIComponent(String(request.headers["x-filename"] ?? ""));
    const mimeType = (request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    const attachment = await threads.upload(threadId, name, mimeType, request);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(attachment));
    return;
  }
  const file = request.method === "GET" && attachmentId ? threads.attachmentFile(threadId, attachmentId) : null;
  if (!file) return replyError(response, 404, "Not found");
  response.writeHead(200, {
    "content-type": file.mimeType,
    "content-length": file.size,
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    // An id always names the same bytes.
    "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  });
  createReadStream(file.path).pipe(response);
}

/** `GET /api/threads/<id>/visualizations/<id>` serves a page the agent showed, sandboxed. */
async function handleVisualization(
  request: IncomingMessage,
  response: ServerResponse,
  threadId: string,
  visualizationId: string,
): Promise<void> {
  if (!isAllowedOrigin(request) || !isSameSiteFetch(request)) return replyError(response, 403, "Forbidden");
  if (request.method !== "GET") return replyError(response, 405, "Method not allowed");
  const page = await threads.visualizationPage(threadId, visualizationId);
  if (!page) return replyError(response, 404, "Not found");
  response.writeHead(200, { ...VISUALIZATION_HEADERS, "content-length": page.length }).end(page);
}

/** `GET /api/threads/<id>/files?root=&path=` serves a file or folder listing for the preview panel. */
async function handleFilePreview(request: IncomingMessage, response: ServerResponse, threadId: string): Promise<void> {
  if (!isAllowedOrigin(request) || !isSameSiteFetch(request)) return replyError(response, 403, "Forbidden");
  if (request.method !== "GET") return replyError(response, 405, "Method not allowed");
  const query = new URL(request.url ?? "/", "http://x").searchParams;
  const root = query.get("root") ?? "workspace";
  if (root !== "workspace" && root !== "project") return replyError(response, 400, "Unknown root");
  const roots = await previewRoots(threadId).catch(() => null);
  if (!roots) return replyError(response, 404, "Unknown thread");
  const preview = await readPreview(roots, root, query.get("path") ?? "");
  const headers = {
    // Files change under agents' hands, so always ask again.
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  };
  if (preview.kind === "directory") {
    response.writeHead(200, { ...headers, "content-type": "application/json", "x-file-kind": "directory" });
    response.end(JSON.stringify({ entries: preview.entries }));
  } else if (preview.kind === "image") {
    response.writeHead(200, { ...headers, "content-type": preview.mimeType, "content-length": preview.size });
    createReadStream(preview.full).pipe(response);
  } else {
    response.writeHead(200, {
      ...headers,
      "content-type": "text/plain; charset=utf-8",
      ...(preview.truncated ? { "x-file-truncated": String(preview.size) } : {}),
    });
    response.end(preview.text);
  }
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = createServer(async (request, response) => {
  const mcpToken = /^\/mcp\/([\w-]+)$/.exec(request.url ?? "")?.[1];
  if (mcpToken) {
    if (!isAllowedOrigin(request)) {
      response.writeHead(403).end();
      return;
    }
    await handleMcpRequest({ threads, files }, mcpToken, request, response).catch((error: Error) => {
      console.error(error);
      if (!response.headersSent) response.writeHead(500).end();
    });
    return;
  }
  const pathname = new URL(request.url ?? "/", "http://x").pathname;
  const attachmentRoute = /^\/api\/threads\/([\w-]+)\/attachments(?:\/([\w-]+))?$/.exec(pathname);
  if (attachmentRoute) {
    await handleAttachments(request, response, attachmentRoute[1]!, attachmentRoute[2]).catch((error: Error) => {
      if (response.headersSent) return response.destroy();
      if (error instanceof AttachmentError) {
        if (error.status === 413) response.setHeader("connection", "close");
        return replyError(response, error.status, error.message);
      }
      replyError(response, 400, error.message);
    });
    return;
  }
  const visualizationRoute = /^\/api\/threads\/([\w-]+)\/visualizations\/([\w-]+)$/.exec(pathname);
  if (visualizationRoute) {
    await handleVisualization(request, response, visualizationRoute[1]!, visualizationRoute[2]!).catch((error: Error) => {
      if (response.headersSent) return response.destroy();
      replyError(response, 500, error.message);
    });
    return;
  }
  const previewRoute = /^\/api\/threads\/([\w-]+)\/files$/.exec(pathname);
  if (previewRoute) {
    await handleFilePreview(request, response, previewRoute[1]!).catch((error: Error) => {
      if (response.headersSent) return response.destroy();
      replyError(response, error instanceof PreviewError ? error.status : 500, error.message);
    });
    return;
  }
  if (pathname.startsWith("/api/")) return replyError(response, 404, "Not found");
  if (!existsSync(config.webDist)) {
    response.writeHead(404).end("Web client not built. Run `pnpm build`, or use `pnpm dev`.");
    return;
  }
  const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname));
  let file = join(config.webDist, path);
  if (!file.startsWith(config.webDist) || !existsSync(file) || path === "/") {
    file = join(config.webDist, "index.html");
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, { "content-type": MIME_TYPES[extname(file)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});

const sockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/ws" || !isAllowedOrigin(request)) {
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit("connection", ws));
});

sockets.on("connection", (ws: WebSocket) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.on("message", async (data) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      return;
    }
    let reply: ServerMessage;
    try {
      reply = { id: message.id, result: (await dispatch(message)) ?? null };
    } catch (error) {
      reply = { id: message.id, error: { message: error instanceof Error ? error.message : String(error) } };
    }
    ws.send(JSON.stringify(reply));
  });
});

server.listen(config.port, config.host, () => {
  console.log(`borkcode listening on http://${config.host}:${config.port} (home: ${config.home})`);
  // After listening, since agents started by these deliveries connect back to the MCP endpoint.
  threads.resumeQueued();
});

// Records running turns as cut off by the server, so neither the user nor the agent mistakes the
// stop for the user's. A second signal exits at once. A kill without a signal handler leaves turns
// marked running, which the next start treats the same way.
function stop(): void {
  void threads.shutdown().finally(() => process.exit());
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("SIGHUP", stop);
