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
- **Local or tailnet access.** The server owns all state and the client only renders it. Keep
  that split; remote clients use the same protocol and HTTP file routes.
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

- **Network access is a server-owned Settings toggle, off by default.** `networkAccess` persists
  in settings.json. `NetworkAccess` keeps the main loopback listener on and adds/removes listeners
  only on Tailscale addresses (100.64.0.0/10 and fd7a:115c:a1e0::/48). No wildcard or LAN bind.
  Discovery retries every 30 seconds while enabled, reading interfaces and the optional CLI.
  The server broadcasts reachable URLs; the browser does not discover its own addresses. An
  existing Serve configuration targeting this port is probed before its HTTPS URL is advertised.
- **Host is allowlisted from loopback and detected Tailscale addresses/MagicDNS.** Proxy headers
  are accepted only from a loopback peer for an allowlisted remote host; Funnel is refused.
  Non-loopback peers must also have Tailscale addresses, closing access from LAN routes.
  `/mcp/` requires a direct loopback peer, loopback Host, no Origin, no browser fetch metadata
  and no proxy headers. Browser Origin and Sec-Fetch-Site checks cover static files and upgrades
  too, except the capability asset routes below and user-activated top-level app navigation.
  Disabling access clears remote Hosts and closes remote sockets without closing the local UI.
- **Plain tailnet HTTP is supported.** Upload queue keys use `crypto.getRandomValues`, available
  outside secure contexts; saved file IDs still come from the server. Copy uses the clipboard API
  when available, then selected-text copy. Image paste uses the paste event, never clipboard.read.
  Asset CSP sources use the incoming scheme: forwarded HTTPS is trusted only from an allowed
  loopback proxy, not from direct tailnet clients.
- **Small screens use a navigation drawer and full-screen side panels.** The app follows
  `visualViewport` for keyboards and safe-area insets. Coarse-pointer composers use a native
  textarea, retaining `@` picking and drafts, with chips in sent messages; desktop keeps the
  contenteditable. Returning to the foreground replaces stale sockets and refreshes server state.

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
  (so ask-mode parents approve each handoff). Their model comes from the first child model rule
  matching the parent's (defaults resolved to names), else the parent's; the agent's explicit
  provider, model or effort layer over that the same way, and a new provider or model drops effort.
  `start_from: this_branch` branches the child from the parent's commits (refused while the parent
  has uncommitted changes); the starting branch is stored so a restart before the workspace exists
  cannot lose it. Deleting a parent keeps its children and drops their link.
- **Archiving hides a thread and its subtree** from the sidebar and project page, keeping
  everything else. It is refused while any of the subtree works, and does not count as activity.
  Unarchiving also restores archived ancestors so the thread stays nested. Any delivery to an
  archived thread unarchives it first, so nothing works out of sight; `list_child_threads` still
  lists archived children, marked as such. The exception is pull request merge and close news:
  an archived thread's PR states still update, but it is not woken and the news is not kept.
- **Messages for a busy agent queue in a per-thread inbox** (SQLite, so they survive restarts):
  the user's, a parent's, and children's reports. Delivery steers them into the running turn at
  its next step when the provider allows, otherwise they start the next turn together. A stop
  holds what was waiting when the turn was stopped until the user sends or resumes; messages that
  arrive later, such as a child's report or a PR merge or close notice, start a turn as usual.
- **A turn cut off by the server is not the user's stop.** The providers report it in the user's
  words ("rejected", "interrupted by user"), so borkcode flags the thread (`server_stopped`): on
  SIGINT/SIGTERM/SIGHUP for running turns, and at startup for threads still marked running after a
  kill or crash. The transcript gets "Stopped: borkcode server shut down", and the next turn,
  whoever starts it, opens with a borkcode note saying so; the flag clears once the agent has it.
  A cut-off watched child also queues a report to its parent, delivered after the restart; the
  child itself waits for a message rather than resuming. A new thread's first message stays in
  the inbox until its workspace is ready, so a thread stopped while `preparing` finishes its
  workspace at startup and then takes the message (with no server note, as no turn had started).
- **A watched child reports every turn that isn't stopped,** including turns the user started, to
  its parent. `watch: true` on `start_thread`, or any message from the parent, makes it watched.
  Captains are a role chosen at creation, with their own instructions and their own worktree.
- **Threads are unread when a turn ended with something for the user since they last read it.**
  The server stores `respondedAt` and `readAt`; the client sends `threads.markRead` after the
  thread has been open in a visible tab for 3 seconds. Stopped turns don't count, and neither does
  a watched child's turn the user didn't join, since its reply is its parent's to read. Reading is
  not activity. Mark as read or unread later only needs to set or clear `readAt`.
- **Delegation limits pause deliveries between threads,** not user messages: too many wake-ups of
  one thread in a window (fast loops), or too many across a captain's tree since the user last
  messaged it (slow loops). Paused threads keep their queue until the user resumes or messages.
- **PRs are linked to threads in SQLite.** The tool links what it opens, and repo status links any
  PR found on the thread's branch, so PRs opened by other means show up too.
- **Open PRs are polled, not hooked.** Webhooks need a public endpoint, so the server asks `gh`
  (one GraphQL query per repo) every minute while any linked PR is open, and also before a turn
  starts, when a thread is opened, and when the user returns to the tab (at most every 15s). A
  linked PR becoming merged or closed wakes the thread that owns it through its inbox (kind
  `borkcode`, labelled as not from the user), which counts as an automatic wake for the
  delegation limits. Parents hear through a watched child's report, not
  directly. A change found just before a turn starts joins that turn.
- **Attachments travel over HTTP, never as browser-side paths,** so a remote browser works too.
  `POST /api/threads/<id>/attachments` stores the raw body under `<home>/attachments/<thread id>/`
  (outside every repo, removed with the thread) and returns `{ id, name, mimeType, size }`;
  messages carry ids, and the inbox and transcript carry the records. Uploads are refused unless
  same-origin, like `/ws`, and only ids that are UUIDs reach the filesystem. Only images are
  accepted for now (not SVG, which could run script from our origin). Adapters send images
  natively (Claude base64 blocks, Codex `localImage` paths) and name every attachment's path in
  the text, which is how other file types will reach agents; the folder is a writable root.
- **The browser reads thread files over HTTP, never by local path,** so previews work from a
  remote browser too. `GET /api/threads/<id>/files?root=workspace|project&path=<rel>` serves a
  file or folder listing from the thread's workspace or its project files, same-origin only like
  attachments. Paths resolve with `realpath` and must stay inside the root (no `..`, symlink
  escapes or `.git`). Text is cut at 1 MB, known image types are served as images, and everything
  goes out with `nosniff` and a sandbox CSP; SVG and HTML are plain text. Transcripts only link
  paths the server confirms exist (`threads.locateFiles`, batched as messages render), trying
  absolute, workspace-relative, repo-relative and project-file forms, so ordinary words never
  link. Images an agent viewed are recorded as a path on the tool item, not as bytes.
- **Visualizations are agent-written HTML, so they run in an opaque origin.** `show_html` stores
  the page as `visualizations/<id>.html` in the thread's attachments folder and records only
  `{ id, title, updatedAt }`. `GET /api/threads/<id>/visualizations/<id>` serves it with
  `Content-Security-Policy: sandbox allow-scripts` (never `allow-same-origin`) and frames use
  `sandbox="allow-scripts"`, so its requests carry `Origin: null`, which `isAllowedOrigin` refuses.
  Resources load from `https:` CDNs or the visualization's own asset route, never arbitrary
  `http:` hosts. Other opaque-origin requests to borkcode are refused by Origin or Sec-Fetch-Site
  even over HTTPS; the policy is `visualizationCsp` in `visualizations.ts`. A served page gets a
  script appended that posts its content height; the card accepts only a clamped number from its own frame.
- **A visualization shown from a file is served live and loads the files beside it.** When the
  file is in the thread's workspace or project files, `<id>.json` records its root and path; the
  page is read from there on each load (the copy stands in if it goes away) and served at
  `.../visualizations/<id>/`, so relative URLs hit `.../visualizations/<id>/<path>`. That route
  serves files in the page's folder and below through `resolveIn`, never hidden files, with
  `nosniff`, the sandbox CSP (so HTML or SVG opened from it stays sandboxed) and
  `Access-Control-Allow-Origin: null` for fonts and fetches. It is the one route that accepts
  the sandbox's `Origin: null` and cross-site requests (`isAssetRequest`); the UUIDs in its URL
  are the capability. The page's CSP names that exact URL prefix as a source, since `'self'` is
  unreliable for an opaque origin and would open all of `/api`. The global request gate
  lets `isAssetRequest` bypass only Origin and fetch-site checks, retaining the Host
  allowlist and proxy/Funnel restrictions. `assetBase` uses HTTPS through an
  allowed loopback proxy and HTTP directly; arbitrary clients cannot choose its scheme with headers.
- **The composer is a contenteditable whose plain text is the source of truth**
  (`ComposerEditor.svelte`), so file references can show as chips. Plain typing and deleting
  inside one text node is left to the browser and read back from that node; redrawing on every
  key made typing lag. Edits touching a chip, newlines, paste and undo go through `beforeinput`,
  are applied to the text and redrawn, with the composer's own undo stack. IME composition edits
  the DOM and is read back when it ends. Chips show the file name and a relative path on hover,
  never an absolute one.
- **Transcript items use `content-visibility: auto`.** Without it every keystroke in the composer
  paid to paint and hit-test the whole transcript. It contains each item's layout and paint, so a
  fixed overlay inside an item must move to `document.body` (`MessageAttachments` does).
- **Clients get everything by broadcast.** It's fine for one user across their devices. Revisit
  if many clients arrive. Keep payloads small: stream deltas, not whole items.

## Where code lives

- `shared/protocol.ts`: every type that crosses the WebSocket. Change it first; server and web follow.
- `server/src/workspaces.ts`, `projects.ts`: git worktrees and project folders.
- `server/src/threads.ts`: thread lifecycle, live session state, approvals.
- `server/src/mcp.ts`: the agent-facing MCP tools. `pullRequests.ts` pushes and opens PRs;
  `files.ts` serves and watches shared project files; `threadFiles.ts` finds and reads thread
  files for the preview panel; `visualizations.ts` stores and serves `show_html` pages.
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
- **A dead provider process must not take the server down.** Writing to the stdin of a Codex
  process that has exited emits `EPIPE` on the stream even while `writable` is true, and an
  unhandled stream error crashes Node. Every child pipe gets an error handler, and the session
  fails on the child's `exit` (not `close`, which a grandchild holding a pipe can delay forever).
  The Claude SDK handles its own pipes but can report the exit before a turn is pushed, so
  `sendTurn` checks for that.
- **Codex MCP tool timeout.** Codex gives MCP tool calls 60 seconds by default, too short for a
  tool waiting on the user's approval. The adapter sets `mcp_servers.borkcode.tool_timeout_sec`.
- **Steering differs per provider.** Codex `turn/steer` is pinned to the running turn id and fails
  cleanly after it ends. Claude takes a user message with `priority: "next"` at the next step
  without aborting tools (`"now"` aborts them), but borkcode only steers while a tool call is
  running: a "next" message sent during the final response might start an untracked turn. Claude
  does not echo steered messages, so the transcript item is recorded by `threads.ts`.
- **Codex asks questions only in plan mode by default.** `request_user_input` needs the
  `features.default_mode_request_user_input` config, which the adapter sets. Claude's
  `AskUserQuestion` reaches `canUseTool` in every permission mode, including bypass.
- **Claude expands `@path` in prompts.** The CLI, also under the SDK, turns each `@path` (or
  `@"path with spaces"`) in a user message into an inlined Read result. Codex passes the text
  through. The composer's `@` picker relies on this and inserts paths, never file contents.
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
- Pure web logic gets `node:test` tests in `web/src/**/*.test.ts`. They can't import `.svelte`
  modules, and the server's tsconfig typechecks them, since only it has Node's types.
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
- No continuously repainting animations; they peg the GPU. The one exception is `Spinner.svelte`,
  a few stepped glyphs in pure CSS, shown only while a thread works. Spinners must not lie about state.
- Don't add docs that restate the code. Record decisions and traps here; user-facing usage goes in
  the README.

## Git

- Commit or open PRs only when asked.
- Conventional commit titles in plain language, e.g. `fix(server): codex threads resume after restart`.
