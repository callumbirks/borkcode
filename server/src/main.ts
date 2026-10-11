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
import { ProjectStore } from "./projects.ts";
import { ThreadService } from "./threads.ts";

const config = loadConfig();
const db = new Database(join(config.home, "state.sqlite"));
const projects = new ProjectStore(config.home);
const clients = new Set<WebSocket>();

function broadcast(event: ServerEvent): void {
  const payload = JSON.stringify({ event } satisfies ServerMessage);
  for (const client of clients) client.send(payload);
}

const threads = new ThreadService(db, projects, broadcast);

async function projectsChanged<T>(result: T): Promise<T> {
  broadcast({ type: "projects.changed", projects: await projects.list() });
  return result;
}

type Handlers = {
  [M in RequestMethod]: (params: Requests[M]["params"]) => Promise<Requests[M]["result"]>;
};

const handlers: Handlers = {
  "projects.list": () => projects.list(),
  "projects.create": async ({ name }) => projectsChanged(await projects.create(name.trim())),
  "repos.add": async ({ project, url, name }) =>
    projectsChanged(await projects.addRepo(project, url, name)),
  "repos.update": async ({ project, name, ...patch }) =>
    projectsChanged(await projects.updateRepo(project, name, patch)),
  "threads.list": async () => threads.list(),
  "threads.create": (params) => threads.create(params),
  "threads.get": ({ threadId }) => threads.get(threadId),
  "threads.send": async ({ threadId, text }) => {
    // The turn runs in the background; progress arrives as events.
    void threads.send(threadId, text).catch((error: Error) => console.error(error));
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
});
