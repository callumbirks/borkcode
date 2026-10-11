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
- **Roadmap:** what's done, next and not planned is in `ROADMAP.md`.

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
- **The filesystem is the source of truth for projects** (`project.json`) and settings
  (`settings.json`), both safe to hand-edit. SQLite holds threads and transcript items only.
- **Threads are named from their first message** by the model in `settings.json`. Isolated
  threads wait for the title so their branch name means something; renaming later changes only
  the displayed title.
- **Model lists come from the CLIs** (Claude `supportedModels()`, Codex `model/list`), never a
  hardcoded list. A null model or effort means the provider's default.
- **Setup commands run once per new worktree,** sequentially in repo order, with
  `BORKCODE_MAIN_REPO`, `BORKCODE_WORKSPACE` and `BORKCODE_PROJECT` set.
- **The agent's workspace orientation is injected** through each provider's system-instruction
  option (`server/src/instructions.ts`). Nothing is written into the workspace.
- **Agents in worktree threads commit as they go** unless `autoCommit` is off; main-checkout
  threads commit only when asked. The policy lives in the injected instructions, which are fixed
  per session, so toggling it affects sessions started afterwards.
- **borkcode tools reach agents over MCP.** The server serves `POST /mcp/<token>` statelessly; each
  agent session gets a fresh random token that maps to its thread, so a tool always acts on its
  own thread. Tools that act on the outside world ask for approval themselves in ask mode, and the
  adapters auto-allow `borkcode` tools so the user is not asked twice.
- **Publishing goes through the `open_pull_requests` tool,** not raw `git push`/`gh`. The server
  pushes the thread branch under the same name (never forced), opens one PR per repo with commits
  ahead, refuses while anything is uncommitted, and links sibling PRs in a marked description block.
- **Follow-ups after a merge stay on the thread's branch.** The `sync_with_base` tool runs
  `git rebase --onto origin/<base> <merged head>`, replaying only commits made after the merged
  PR's head, because a plain rebase re-applies squash-merged commits and conflicts. Publishing
  refuses until a merged repo is synced. The next push may overwrite the remote branch only via
  `--force-with-lease` pinned to that merged head.
- **Shared project files are plain files in `<project>/files/`.** Agents use borkcode's file tools
  or their own; the server watches the folder, so every change reaches the UI however it was
  made. Saves from the UI carry the mtime they loaded and are refused if the file changed since,
  so an agent's edit is never silently overwritten.
- **Each thread has a scratch folder for temporary files,** so working files stay out of the
  repos and out of project files. Worktree threads use `.scratch/` in the workspace root (inside
  the agent's cwd, so no approvals; never a repo name, since those start with a letter or digit),
  removed with the workspace. Main-checkout threads use `<project>/scratch/<thread id>/`, passed
  as a writable root and deleted with the thread. A handed-off thread's brief is saved there as
  `brief.md` so it survives compaction; briefs go to project files only when the user asks.
- **Threads can start threads** through the `start_thread` tool, which goes through the same path
  as the new-thread form. Children always get a new worktree and inherit the parent's access mode
  (so ask-mode parents approve each handoff), and its provider and model unless told otherwise.
  `start_from: this_branch` branches the child from the parent's commits (refused while the parent
  has uncommitted changes); the starting branch is stored so a restart before the workspace exists
  cannot lose it. Deleting a parent keeps its children and drops their link.
- **Messages for a busy agent queue in a per-thread inbox** (SQLite, so they survive restarts):
  the user's, a parent's, and children's reports. Delivery steers them into the running turn at
  its next step when the provider allows, otherwise they start the next turn together. After the
  user stops a turn, nothing is delivered until they send or resume: stop means stop.
- **A watched child reports every turn that isn't stopped,** including turns the user started, to
  its parent. `watch: true` on `start_thread`, or any message from the parent, makes it watched.
  Captains are a role chosen at creation, with their own instructions and their own worktree.
- **Delegation limits pause deliveries between threads,** not user messages: too many wake-ups of
  one thread in a window (fast loops), or too many across a captain's tree since the user last
  messaged it (slow loops). Paused threads keep their queue until the user resumes or messages.
- **PRs are linked to threads in SQLite.** The tool links what it opens, and repo status links any
  PR found on the thread's branch, so PRs opened by other means show up too.
- **Open PRs are polled, not hooked.** Webhooks need a public endpoint, so the server asks `gh`
  (one GraphQL query per repo) every minute while any linked PR is open, and also before a turn
  starts and when a thread is opened. State changes don't wake agents: the next turn opens with a
  "Since your last turn" line, tracked per PR as what the thread's agent and its parent's agent
  were last told.
- **Clients get everything by broadcast.** It's fine for one local user. Revisit if remote access
  or many clients arrive. Keep payloads small: stream deltas, not whole items.

## Where code lives

- `shared/protocol.ts`: every type that crosses the WebSocket. Change it first; server and web follow.
- `server/src/workspaces.ts`, `projects.ts`: git worktrees and project folders.
- `server/src/threads.ts`: thread lifecycle, live session state, approvals.
- `server/src/mcp.ts`: the agent-facing MCP tools. `pullRequests.ts` pushes and opens PRs;
  `files.ts` serves and watches shared project files.
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
- **Turn overrides stick.** Codex `turn/start` `model` and `effort` apply to later turns too, and
  null means "no change", not "default". Codex reports each model's default effort, so the picker
  never moves a Codex thread from a set effort back to null. Claude switches with `setModel` and
  `applyFlagSettings({ effortLevel })`, where null does reset.
- **Codex MCP tool timeout.** Codex gives MCP tool calls 60 seconds by default, too short for a
  tool waiting on the user's approval. The adapter sets `mcp_servers.borkcode.tool_timeout_sec`.
- **Steering differs per provider.** Codex `turn/steer` is pinned to the running turn id and fails
  cleanly after it ends. Claude takes a user message with `priority: "next"` at the next step
  without aborting tools (`"now"` aborts them), but borkcode only steers while a tool call is
  running: a "next" message sent during the final response might start an untracked turn. Claude
  does not echo steered messages, so the transcript item is recorded by `threads.ts`.
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
