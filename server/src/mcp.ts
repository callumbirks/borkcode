import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ToolError } from "./errors.ts";
import type { FileStore } from "./files.ts";
import type { ThreadService } from "./threads.ts";

interface Services {
  threads: ThreadService;
  files: FileStore;
}

/** Agents reach these tools as the "borkcode" MCP server. Each session's token picks its thread. */
export const MCP_SERVER_NAME = "borkcode";

function text(content: string, isError = false) {
  return { content: [{ type: "text" as const, text: content }], isError };
}

/** Expected failures go back to the agent as tool errors it can act on; anything else is a bug. */
async function toolResult(work: () => Promise<string>) {
  try {
    return text(await work());
  } catch (error) {
    if (error instanceof ToolError) return text(error.message, true);
    console.error(error);
    return text(error instanceof Error ? error.message : String(error), true);
  }
}

function buildServer({ threads, files }: Services, threadId: string): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: "0.1.0" });
  const project = threads.projectOf(threadId);
  const path = z.string().describe("Path relative to the project files folder, such as specs/login.md");

  server.registerTool(
    "list_project_files",
    {
      description:
        "List the project's shared files: notes, specs and plans that every thread of this project and the user can read and write. " +
        "Paths are relative to the project files folder.",
    },
    () =>
      toolResult(async () => {
        const list = await files.list(project);
        if (list.length === 0) return "The project has no shared files yet.";
        return list
          .map((file) => `${file.path}  (${file.size} bytes, modified ${new Date(file.modifiedAt).toISOString()})`)
          .join("\n");
      }),
  );

  server.registerTool(
    "read_project_file",
    { description: "Read one of the project's shared files.", inputSchema: { path } },
    ({ path }) => toolResult(async () => (await files.read(project, path)).content),
  );

  server.registerTool(
    "write_project_file",
    {
      description:
        "Create or replace one of the project's shared files, creating folders as needed. " +
        "Other threads and the user see the change right away, so keep files tidy and say in your reply what you wrote. " +
        "Replaces the whole file: read it first when changing part of it.",
      inputSchema: { path, content: z.string().describe("The complete new contents") },
    },
    ({ path, content }) =>
      toolResult(async () => {
        const file = await files.write(project, path, content);
        return `Wrote ${file.path} (${file.size} bytes).`;
      }),
  );

  server.registerTool(
    "start_thread",
    {
      description: [
        "Hand work off to a new thread in this project, running in its own new worktree. Only do this when the user asks.",
        "The new thread sees only your message, not this conversation, so make it self-contained: the goal, what has been decided or tried, the relevant files, branches and pull requests, and what done looks like.",
        "For a long brief, first write it to a project file (for example handoffs/<topic>.md) with write_project_file, and tell the new thread to read it.",
        "The new thread uses this thread's access mode, and this thread's provider and model unless you choose others; give them only if the user asked for them.",
        "The user may be asked to approve.",
      ].join(" "),
      inputSchema: {
        message: z.string().describe("The new thread's first message: its complete brief"),
        start_from: z
          .enum(["base", "this_branch"])
          .describe(
            "base: a fresh branch from each repository's base branch, for separate work. " +
              "this_branch: a branch from this thread's current commits, to continue this work with fresh context; " +
              "its pull requests will include this thread's commits. Commit first, since uncommitted changes do not carry over.",
          ),
        provider: z.enum(["claude", "codex"]).optional().describe("Agent for the new thread; defaults to this thread's"),
        model: z.string().optional().describe("Model id, as the provider lists it; defaults to this thread's model when the provider is the same"),
        effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional().describe("Reasoning effort; defaults to this thread's"),
      },
    },
    ({ message, start_from, provider, model, effort }) =>
      toolResult(() => threads.startThread(threadId, { message, startFrom: start_from, provider, model, effort })),
  );

  server.registerTool(
    "list_child_threads",
    {
      description:
        "List the threads this thread started, with each one's status, model, branch, pull requests and latest reply. " +
        "Refreshes pull requests from GitHub first.",
    },
    () => toolResult(() => threads.listChildThreads(threadId)),
  );

  server.registerTool(
    "list_pull_requests",
    {
      description:
        "List the pull requests linked to this thread, with their repository, number, URL, state and title. " +
        "Refreshes from GitHub first, so it includes pull requests opened on this thread's branch by other means.",
    },
    () => toolResult(async () => JSON.stringify(await threads.listPullRequests(threadId), null, 2)),
  );

  server.registerTool(
    "open_pull_requests",
    {
      description: [
        "Push this thread's branch and open GitHub pull requests, one per repository with commits ahead of its base branch.",
        "Use this instead of running git push or gh pr create yourself.",
        "Commit everything first: it refuses while any repository has uncommitted changes.",
        "Give a title and body for each repository with commits but no open pull request.",
        "Repositories that already have an open pull request just get the new commits pushed, and may be left out.",
        "Sibling pull requests are linked in each description. It never force-pushes. The user may be asked to approve.",
      ].join(" "),
      inputSchema: {
        pullRequests: z
          .array(
            z.object({
              repo: z.string().describe("Repository directory name, as in the workspace"),
              title: z.string().describe("Pull request title"),
              body: z.string().describe("Pull request description in Markdown: what changed, why, and how it was tested"),
            }),
          )
          .describe("One entry per repository that needs a new pull request"),
      },
    },
    ({ pullRequests }) => toolResult(() => threads.openPullRequests(threadId, pullRequests)),
  );

  server.registerTool(
    "sync_with_base",
    {
      description: [
        "Bring this thread's branch up to date after one of its pull requests was merged.",
        "In each repository whose latest pull request was merged, it fetches and replays only the commits made after the merged head onto the latest base branch, so the merged work is not repeated.",
        "Repositories with no commits ahead are fast-forwarded to the latest base branch; others are left alone.",
        "Refuses while any repository has uncommitted changes, so commit first.",
        "If replaying conflicts, that repository is left unchanged and the conflicting files are listed.",
      ].join(" "),
    },
    () => toolResult(() => threads.syncWithBase(threadId)),
  );

  return server;
}

/** Serves `POST /mcp/<token>` statelessly: each request gets a fresh server bound to the token's thread. */
export async function handleMcpRequest(
  services: Services,
  token: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const threadId = services.threads.threadForMcpToken(token);
  if (!threadId) {
    response.writeHead(401).end();
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST" }).end();
    return;
  }
  const server = buildServer(services, threadId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(request, response);
}
