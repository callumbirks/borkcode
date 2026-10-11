import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { extname, join, normalize } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  ClientMessage,
  RequestMethod,
  Requests,
  ServerEvent,
  ServerMessage,
} from "shared/protocol";
import { loadConfig } from "./config.ts";
import { Database } from "./db.ts";
import { FileStore } from "./files.ts";
import { handleMcpRequest } from "./mcp.ts";
import { listModels } from "./models.ts";
import { ProjectStore } from "./projects.ts";
import { SettingsStore } from "./settings.ts";
import { ThreadService } from "./threads.ts";

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
const threads = new ThreadService(db, projects, settings, broadcast, `http://${mcpHost}:${config.port}/mcp/`);

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
  "threads.list": async () => threads.list(),
  "threads.create": (params) => threads.create(params),
  "threads.get": ({ threadId }) => threads.get(threadId),
  "threads.send": async ({ threadId, text, model, effort }) => {
    // The turn runs in the background; progress arrives as events.
    void threads.send(threadId, text, { model, effort }).catch((error: Error) => console.error(error));
    return null;
  },
  "threads.rename": async ({ threadId, title }) => threads.rename(threadId, title),
  "threads.publish": async ({ threadId, model, effort }) => {
    // Like threads.send, the turn runs in the background.
    void threads.publish(threadId, { model, effort }).catch((error: Error) => console.error(error));
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
  "threads.delete": async ({ threadId, force }) => {
    await threads.delete(threadId, force ?? false);
    return null;
  },
  "threads.repoStatus": ({ threadId }) => threads.repoStatus(threadId),
  "approvals.respond": async ({ threadId, approvalId, allow }) => {
    threads.respondToApproval(threadId, approvalId, allow);
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

/** Browsers let any page open a WebSocket to localhost, so only same-origin pages may connect. */
function isAllowedOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
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
