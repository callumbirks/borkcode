import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Item } from "../shared/protocol.ts";
import { AttachmentStore } from "../server/src/attachments.ts";
import { Database, type StoredThread } from "../server/src/db.ts";
import { VisualizationStore } from "../server/src/visualizations.ts";

export type { Item };
/** `updatedAt` defaults to the time of seeding, so threads are fresh unless they say otherwise. */
export type StoredThreadSeed = { id: string; title: string; items: Item[]; updatedAt?: number };

export const PROJECT = "demo";
export const WORKSPACE = "e2e";

/** One project with one repo, cloned in `repos/`; every thread is a Codex thread in the same workspace. */
export async function seed(home: string, threads: StoredThreadSeed[], visualizations: Record<string, Record<string, string>>, png: Buffer) {
  const project = join(home, "projects", PROJECT);
  const app = join(project, "worktrees", WORKSPACE, "app");
  await mkdir(app, { recursive: true });
  await mkdir(join(project, "files"), { recursive: true });
  await writeFile(join(project, "project.json"), JSON.stringify({ repos: [{ name: "app", url: "https://example.com/app", baseBranch: "main", setup: null }] }));
  execFileSync("git", ["init", "-q"], { cwd: app });
  await writeFile(join(app, "README.md"), "# App\n\nPreviewed from the transcript.\n" + "More lines of the readme.\n".repeat(40));
  await writeFile(join(app, "tall.png"), png);
  // The main clone, which new threads list @ files from and branch their worktrees from.
  const main = join(project, "repos", "app");
  await mkdir(main, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: main });
  await writeFile(join(main, "README.md"), "# App\n");
  await writeFile(join(main, "ONBOARDING.md"), "# Onboarding\n");
  execFileSync("git", ["add", "."], { cwd: main });
  execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "commit", "-qm", "init"], { cwd: main });

  const db = new Database(join(home, "state.sqlite"));
  const store = new VisualizationStore(new AttachmentStore(home));
  const now = Date.now();
  for (const [index, { id, title, items, updatedAt }] of threads.entries()) {
    const thread: StoredThread = {
      id, project: PROJECT, title, provider: "codex", model: null, effort: null, accessMode: "full",
      workspace: WORKSPACE, branch: `borkcode/${WORKSPACE}`, status: "idle", providerSessionId: null,
      parentId: null, startBranch: null, captain: false, watched: false, paused: false, queued: 0,
      archivedAt: null, respondedAt: null, readAt: null, markedUnread: false,
      createdAt: now + index, updatedAt: updatedAt ?? now + index,
    };
    db.insertThread(thread);
    for (const item of items) db.upsertItem(id, item);
    for (const [visualizationId, html] of Object.entries(visualizations[id] ?? {})) await store.save(id, html, visualizationId);
  }
}
