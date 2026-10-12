import { join } from "node:path";
import type { Item, Thread } from "shared/protocol";
import type { Database } from "./db.ts";
import { ToolError } from "./errors.ts";
import type { ProjectStore } from "./projects.ts";

export const PAGE_CHARACTERS = 16_000;
export const ITEM_CHARACTERS = 2_000;

function bounded(value: number | undefined, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new ToolError(`limit must be an integer from 1 to ${max}`);
  return value;
}

/** Transcript prose only: tool inputs/outputs and reasoning stay out of other agents' context. */
export function describeItem(item: Item): { source: string; text: string } | null {
  switch (item.kind) {
    case "reasoning": return null;
    case "user": return {
      source: item.fromBorkcode ? "borkcode" : item.fromThreadId ? `thread:${item.fromThreadId}` : "user",
      text: item.text + (item.attachments?.length ? `\n[Attachments: ${item.attachments.map(a => a.name).join(", ")}]` : ""),
    };
    case "assistant": return { source: "assistant", text: item.text };
    case "tool": return { source: "tool", text: `${item.name}: ${item.summary.replace(/\s+/g, " ")} (${item.status})` };
    case "notice": return { source: "borkcode", text: item.text };
    case "thread": return { source: "handoff", text: `Started thread:${item.threadId}` };
    case "visualization": return { source: "visualization", text: item.title };
    case "question": return { source: "assistant question", text: item.questions.map((q, i) =>
      `${q.question}${q.options.length ? `\nOptions: ${q.options.map(o => o.label).join(", ")}` : ""}\nAnswer: ${item.answers ? item.answers[i]?.join(", ") || "(empty)" : "(unanswered)"}`,
    ).join("\n") };
  }
}

function truncate(text: string, max: number) {
  const marker = "\n[truncated; use read_thread_item]";
  return text.length <= max ? text : text.slice(0, Math.max(0, max - marker.length)) + marker;
}

/** Read-only discovery shared by the MCP tools. No deliveries, PR refreshes or read receipts. */
export class ThreadReferences {
  readonly db: Database;
  readonly projects: ProjectStore;
  readonly list: () => Thread[];
  constructor(db: Database, projects: ProjectStore, list: () => Thread[]) {
    this.db = db;
    this.projects = projects;
    this.list = list;
  }

  require(id: string) {
    const thread = this.db.getThread(id);
    if (!thread) throw new ToolError(`Unknown thread "${id}"`);
    return thread;
  }

  async listProjects(project?: string) {
    let projects;
    try { projects = project === undefined ? await this.projects.list() : [await this.projects.get(project)]; }
    catch { throw new ToolError(`Unknown project "${project}"`); }
    const threads = this.list();
    return projects.map(p => ({ ...p, filesRoot: join(p.path, "files"),
      threads: { active: threads.filter(t => t.project === p.name && t.archivedAt === null).length,
        archived: threads.filter(t => t.project === p.name && t.archivedAt !== null).length },
    }));
  }

  async listThreads(project: string, includeArchived = false, cursor?: string, limit?: number) {
    await this.listProjects(project);
    const count = bounded(limit, 50, 100);
    let after: { updatedAt: number; id: string } | null = null;
    if (cursor) {
      try {
        const parsed = JSON.parse(cursor);
        if (parsed.project !== project || parsed.archived !== includeArchived || !Number.isSafeInteger(parsed.updatedAt) || typeof parsed.id !== "string") throw new Error();
        after = parsed;
      } catch { throw new ToolError("Invalid thread list cursor"); }
    }
    const candidates = this.list().filter(t => t.project === project && (includeArchived || t.archivedAt === null))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .filter(t => !after || t.updatedAt < after.updatedAt || (t.updatedAt === after.updatedAt && t.id.localeCompare(after.id) > 0));
    const page = candidates.slice(0, count);
    const more = candidates.length > page.length;
    const last = page.at(-1);
    return { threads: page.map(t => ({ id: t.id, project: t.project, title: t.title, provider: t.provider,
      model: t.model, status: t.status, parentId: t.parentId, captain: t.captain, archivedAt: t.archivedAt,
      updatedAt: t.updatedAt, waiting: t.waiting, paused: t.paused,
      unread: t.respondedAt !== null && (t.readAt === null || t.respondedAt > t.readAt),
      pullRequests: this.db.listPullRequests(t.id).map(({ repo, number, state, url }) => ({ repo, number, state, url })),
    })), more, next_cursor: more && last ? JSON.stringify({ project, archived: includeArchived, updatedAt: last.updatedAt, id: last.id }) : null };
  }

  readThread(threadId: string, from: "end" | "start" = "end", cursor?: string, limit?: number) {
    const thread = this.require(threadId);
    const count = bounded(limit, 10, 50);
    let seq: number | null = null;
    if (cursor !== undefined) {
      const prefix = `${threadId}:${from}:`;
      const value = cursor.startsWith(prefix) ? cursor.slice(prefix.length) : "";
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ToolError("Invalid transcript cursor for this thread and direction");
      seq = Number(value);
    }
    const rows = this.db.pageItems(threadId, from, seq, count + 1);
    const messages = [];
    let characters = 2;
    let last: number | null = null;
    for (const row of rows.slice(0, count)) {
      const described = describeItem(row.item)!;
      const message = { id: row.item.id, seq: row.seq, kind: row.item.kind, source: described.source,
        text: truncate(described.text, ITEM_CHARACTERS), truncated: described.text.length > ITEM_CHARACTERS };
      const size = JSON.stringify(message).length + (messages.length ? 1 : 0);
      if (characters + size > PAGE_CHARACTERS) break;
      messages.push(message);
      characters += size;
      last = row.seq;
    }
    const more = rows.length > messages.length;
    if (from === "end") messages.reverse();
    return { thread: { id: thread.id, title: thread.title.slice(0, 200), project: thread.project }, messages, more,
      next_cursor: more && last !== null ? `${threadId}:${from}:${last}` : null };
  }

  readItem(threadId: string, itemId: string, offset = 0, limit?: number) {
    this.require(threadId);
    const item = this.db.getItem(threadId, itemId);
    if (!item) throw new ToolError(`Unknown item "${itemId}" in thread "${threadId}"`);
    const described = describeItem(item);
    if (!described) throw new ToolError("Reasoning items are not available");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > described.text.length) throw new ToolError("Invalid item offset");
    const count = bounded(limit, PAGE_CHARACTERS, PAGE_CHARACTERS);
    const end = Math.min(offset + count, described.text.length);
    return { id: item.id, kind: item.kind, source: described.source, text: described.text.slice(offset, end),
      more: end < described.text.length, next_offset: end < described.text.length ? end : null };
  }
}
