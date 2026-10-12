import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ToolError } from "./errors.ts";
import type { FileStore } from "./files.ts";
import type { ThreadService } from "./threads.ts";
import { MAX_VISUALIZATION_BYTES } from "./visualizations.ts";

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

  const references = threads.references();
  server.registerTool("list_projects", {
    description: "Discover projects in this borkcode home: names, descriptions, repos, shared files roots and active/archived thread counts. Give project for one project's details.",
    inputSchema: { project: z.string().optional() },
  }, ({ project }) => toolResult(async () => JSON.stringify(await references.listProjects(project))));

  server.registerTool("list_threads", {
    description: "List threads by recent activity with IDs, titles, models, status, parent/captain relationships and stored PR states. Defaults to this project and non-archived threads. Read-only; does not refresh PRs. Follow next_cursor while more is true.",
    inputSchema: { project: z.string().optional(), include_archived: z.boolean().optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
  }, (args) => toolResult(async () => JSON.stringify(await references.listThreads(args.project ?? project, args.include_archived, args.cursor, args.limit))));

  server.registerTool("read_thread", {
    description: "Read any thread in this borkcode home without changing its state. Start with the last 10 items (from=end); pages are chronological, with next_cursor pointing older from=end or newer from=start. Reasoning is skipped; tools are one-line summaries. At most 50 items and 16000 message characters per page, each text truncated at 2000. Use read_thread_item for longer text.",
    inputSchema: { thread_id: z.string(), from: z.enum(["end", "start"]).optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(50).optional() },
  }, (args) => toolResult(async () => JSON.stringify(references.readThread(args.thread_id, args.from, args.cursor, args.limit))));

  server.registerTool("read_thread_item", {
    description: "Read untruncated text for one transcript item, in chunks of up to 16000 characters. Follow next_offset while more is true. Tool calls still give summaries; reasoning is unavailable.",
    inputSchema: { thread_id: z.string(), item_id: z.string(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(16000).optional() },
  }, (args) => toolResult(async () => JSON.stringify(references.readItem(args.thread_id, args.item_id, args.offset, args.limit))));

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
    "show_html",
    {
      description: [
        "Show an HTML page to the user, rendered right in this thread: a chart of data, a diagram, a comparison table, a UI mockup or a small interactive exploration.",
        "Give the HTML itself, or the path of an HTML file you wrote in your workspace or the project files.",
        "A file is shown live, so the user sees your edits when it reloads, and its relative URLs load the files in its folder and below, such as images, fonts, scripts, CSS and JSON (not hidden files, nor anything above its folder).",
        `Otherwise the page must be self-contained, up to ${MAX_VISUALIZATION_BYTES / 1024 / 1024} MB. Resources from https: URLs load, such as chart libraries from a CDN, but local files and http: URLs do not.`,
        "It runs sandboxed: scripts work, but forms, popups and navigating away do not.",
        "Pass the id an earlier call returned to replace that visualization instead of adding another.",
      ].join(" "),
      inputSchema: {
        title: z.string().describe("A short title shown above it"),
        html: z.string().optional().describe("The complete HTML document; give this or path"),
        path: z.string().optional().describe("An HTML file to show, absolute or relative to your working directory; give this or html"),
        id: z.string().optional().describe("The id of a visualization shown earlier in this thread, to replace it"),
      },
    },
    ({ title, html, path, id }) => toolResult(() => threads.showHtml(threadId, { title, html, path, id })),
  );

  server.registerTool(
    "start_thread",
    {
      description: [
        "Start a new thread in this project, running in its own new worktree, to hand work off or to delegate it.",
        "The new thread sees only your message, not this conversation, so make it self-contained: the goal, what has been decided or tried, the relevant files and pull requests, and what done looks like.",
        "Do not name a branch for it: it works on a new branch of its own, which it already knows.",
        "However long the brief, send it as the message: it is saved as brief.md in the new thread's scratch folder, so the thread can re-read it and it is cleaned up with the thread. Write a brief to a project file only when the user asks for one.",
        "The new thread uses this thread's access mode, and the provider and model the user's child model rules pick for it (else this thread's) unless you choose others; give them only if the user asked for them. Its fast mode is the matching rule's (on or off) or else this thread's, and applies only where its model offers it.",
        "The user may be asked to approve.",
      ].join(" "),
      inputSchema: {
        message: z.string().describe("The new thread's first message: its complete brief"),
        watch: z
          .boolean()
          .describe(
            "true: delegate and keep track. The thread's final reply comes back to you as a message, and you can answer it with send_to_thread. " +
              "false: hand off and move on, as if the user had started the thread themselves.",
          ),
        start_from: z
          .enum(["base", "this_branch"])
          .describe(
            "base: a fresh branch from each repository's base branch, for separate work. " +
              "this_branch: a branch from this thread's current commits, to continue this work with fresh context; " +
              "its pull requests will include this thread's commits. Commit first, since uncommitted changes do not carry over.",
          ),
        provider: z.enum(["claude", "codex"]).optional().describe("Agent for the new thread; defaults to the child model rules' or this thread's"),
        model: z.string().optional().describe("Model id, as the provider lists it; defaults to the child model rules' or this thread's model when the provider is the same"),
        effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional().describe("Reasoning effort; defaults to the model's own when you choose a model or another provider, else to the child model rules' or this thread's"),
      },
    },
    ({ message, watch, start_from, provider, model, effort }) =>
      toolResult(() => threads.startThread(threadId, { message, watch, startFrom: start_from, provider, model, effort })),
  );

  server.registerTool(
    "send_to_thread",
    {
      description: [
        "Send a message to a thread you started: an answer to its question, a correction or new instructions.",
        "If it is busy, the message joins its work at its next step, or waits for its current turn to end.",
        "Its final reply comes back to you as a message, so there is no need to poll.",
        "Do not send messages that only acknowledge or thank.",
      ].join(" "),
      inputSchema: {
        thread_id: z.string().describe("The id of the thread, as start_thread or list_child_threads gave it"),
        message: z.string().describe("The message, self-contained enough to act on"),
      },
    },
    ({ thread_id, message }) => toolResult(async () => threads.sendToThread(threadId, thread_id, message)),
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
