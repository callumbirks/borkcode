# borkcode

borkcode is a local GUI for coding agents that work across several repositories at once. A Node
server drives the Claude Code and Codex CLIs and serves a Svelte web client. The UX target is
Capy: projects that span repos, a long-lived "captain" thread that delegates to other threads, and
files shared between threads and agents. Unlike Capy, everything runs on the user's own machine,
using their own Claude and Codex logins rather than API keys.

## Scope

Build the smallest thing that makes the intended behavior obvious. Fight scope creep, and do not
add machinery because it looks architecturally impressive.

- **Providers:** Claude and Codex only.
- **Local only for now.** Remote access may come later, so the server owns all state and the
  client only renders it. Keep that split; it is what makes remote cheap later.
- **Not planned yet:** checkpoints/restore, mobile, other providers.
- **Done:** multi-repo projects and workspaces (milestone 1).
- **Next, roughly in order:** shared project files with agent tools (via an MCP server we inject),
  then captain threads that delegate to child threads and see their PRs.

This started as a fork of t3code, which is kept at `~/projects/apps/borkcode` as a read-only
reference. We chose not to build on it because its orchestration model differs from the one we
want and it carries a lot we don't need. Borrow its knowledge, not its architecture. Its provider
adapters (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`, `CodexAdapterV2.ts`)
record many edge cases in streaming, approvals, interrupts and resume. Look there before
inventing a fix.

## Glossary

- **project:** a folder under `<home>/projects/` grouping repos. `project.json` lists them.
- **repo:** a main clone in `repos/<name>/`. Its directory name is significant.
- **workspace:** a folder holding one checkout of every project repo as siblings. A thread
  workspace is `worktrees/<slug>/`; the main clones in `repos/` are also a workspace.
- **thread:** a durable conversation with one agent in one workspace.
- **turn:** one user message and the agent's work in response to it.
- **provider:** Claude or Codex, behind an adapter in `server/src/providers/`.

## Design decisions

- **Every workspace contains every repo,** named exactly like in `repos/`. Projects depend on
  sibling paths such as `../vessel`; never make repo membership per-thread.
- **One branch per thread across all repos:** `borkcode/<slug>`, branched from each repo's base
  branch, preferring `origin/<base>`. Repos the agent never touches simply have no commits ahead.
- **The agent's cwd is the workspace root,** which is not a git repo. Both providers accept this.
- **Deleting a thread removes its worktrees but keeps its branches.** It refuses when a worktree
  has uncommitted changes, unless forced.
- **The filesystem is the source of truth for projects** (`project.json`, safe to hand-edit).
  SQLite holds threads and transcript items only.
- **Setup commands run once per new worktree,** sequentially in repo order, with
  `BORKCODE_MAIN_REPO`, `BORKCODE_WORKSPACE` and `BORKCODE_PROJECT` set.
- **The agent's workspace orientation is injected** through each provider's system-instruction
  option (`server/src/instructions.ts`). Nothing is written into the workspace.
- **Agents open PRs themselves with `gh`.** The app only discovers them by branch, one PR per repo.
- **Clients get everything by broadcast.** It's fine for one local user. Revisit if remote access
  or many clients arrive. Keep payloads small: stream deltas, not whole items.

## Where code lives

- `shared/protocol.ts`: every type that crosses the WebSocket. Change it first; server and web follow.
- `server/src/workspaces.ts`, `projects.ts`: git worktrees and project folders.
- `server/src/threads.ts`: thread lifecycle, live session state, approvals.
- `server/src/providers/`: one adapter per provider, normalizing to `Item`s via `SessionEvents`.
  Provider quirks stay inside the adapter; `threads.ts` and the UI stay provider-agnostic.
- `server/src/main.ts`: the HTTP/WebSocket transport. Keep handlers thin: decode, call one
  service method, return.
- `web/src/`: Svelte 5 (runes). State and the RPC client are in `lib/`.

## Traps we already hit

- **Codex sandbox and worktrees.** A worktree's git metadata lives in the main clone's `.git`,
  outside the workspace. In `workspace-write` mode, commits fail unless each `repos/<name>/.git`
  is passed as a writable root (`threads.ts` does this).
- **Running TypeScript in Node.** The server runs `.ts` directly via Node's type stripping. Use
  erasable syntax only: no enums, namespaces or constructor parameter properties. Relative
  imports keep their `.ts` extension. Import from `shared/protocol` (no extension) and only with
  `import type`, since it is erased at runtime.
- **svelte-check needs TypeScript 6.** It does not support TypeScript 7 alone, so `web` pins
  `typescript@~6` while `server` uses 7. Don't "fix" the mismatch.
- **`node:sqlite` is experimental in Node 22** and prints a warning. Scripts pass
  `--disable-warning=ExperimentalWarning`.
- **Codex protocol types.** Get them from the installed CLI with
  `codex app-server generate-ts --out <dir>`. `providers/codex.ts` hand-writes only the slice it
  uses; extend it from the generated types rather than guessing. The wire format is
  newline-delimited JSON-RPC without a `"jsonrpc"` field.
- **Claude SDK types.** The source of truth is
  `server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`. With partial messages on,
  `assistant` messages arrive one content block at a time, after the matching `stream_event`
  deltas.

## Ways to hurt the user

1. **Their real data.** `~/borkcode` is the user's live state. Never run a dev or test server
   against it, and never delete from it. Use `BORKCODE_HOME=<tmp dir>` with a different `PORT`.
2. **Killing by pattern.** Never `pkill -f` or kill a PID found by matching names. Other servers
   and agents run on this machine, possibly including the one driving you. Kill only PIDs you
   captured when you spawned them.
3. **Provider usage.** Live runs against Claude or Codex spend the user's subscription. Keep
   prompts tiny, and ask before anything long-running.

## Verifying

- Smallest proof that the change works. Run `pnpm test`, and `pnpm typecheck` for type changes.
- Workspace and git behavior is tested against real git in temp directories
  (`server/src/workspaces.test.ts`); follow that pattern rather than mocking git.
- Test behavior, not wiring. Never use sleeps or timeouts to make a test pass; wait on the event
  that marks the milestone.
- For provider changes, a scripted smoke run is the real proof: start the server on a temp home
  with a captured PID, drive it over `/ws`, auto-approve, and check the transcript and repo
  status. Say when you could not run one.
- Do not open a browser or use computer use unless the user agrees.

## Taste

- Complexity belongs at the adapter boundary. Threads stay provider-agnostic; the UI stays dumb.
- If you add a way in, add the way out and a way to see it.
- Inferred types over annotations; `any` is the enemy.
- Comments say how a thing is used or why it is surprising. Don't narrate control flow.
- No continuously repainting animations; they peg the GPU. Spinners must not lie about state.
- Don't add docs that restate the code. Record decisions and traps here; user-facing usage goes in
  the README.

## Git

- Commit or open PRs only when asked.
- Conventional commit titles in plain language, e.g. `fix(server): codex threads resume after restart`.
