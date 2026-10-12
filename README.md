# borkcode

A local workspace for coding agents (Claude Code and Codex) that work across several repositories at once.

## How it is laid out

Everything lives under `~/borkcode` (override with `BORKCODE_HOME`):

```
~/borkcode/
  state.sqlite                  threads and transcripts
  settings.json                 app settings such as the title model (safe to hand-edit)
  projects/<project>/
    project.json                repos, base branches, setup commands (safe to hand-edit)
    files/                      shared project files, writable by every agent
    repos/<repo>/               main clones
    worktrees/<thread>/<repo>/  one git worktree per repo for each thread
```

`files/` holds a project's shared files: specs, plans and decisions that you and every agent in the
project can read and write. Browse and edit them from the project page, where folders collapse and
can be deleted whole; agents reach them through borkcode's tools or their own, and changes show up
live. Temporary files an agent makes go in its thread's scratch folder instead (`.scratch/` in the
thread's workspace), which is deleted with the thread.

A thread's workspace always holds every repo of its project as siblings, named exactly like in
`repos/`, so relative paths such as `../vessel` work the same everywhere. All worktrees in a
workspace share one branch, `borkcode/<thread>`. Deleting a thread removes its worktrees and keeps
the branches. A thread can also run directly in the main clones instead.

Archiving a thread tucks it and the threads it started away on the **Archived** page, keeping its
transcript, workspace, branch and pull requests. It can't be archived while any of them is working.
Unarchive it from there or from the thread itself; a message to an archived thread, from you or
from its parent, also brings it back.

A thread starts from its first message. A small model, chosen under Settings (Codex `gpt-6-luna`
at low effort by default), names it, and the workspace and branch are named after that title.
Renaming a thread later changes only its displayed title. Model and effort can be switched
between turns from the composer.

Type `@` in the composer to reference a file from any of the project's repos or its shared project
files. Suggestions narrow as you type; arrow keys move, Enter or Tab inserts, Escape closes. Repo
files are inserted as `@<repo>/<path>`, relative to the agent's working directory, and project
files by their absolute path. Claude reads referenced files into the message itself; Codex sees
the path and opens the file when it needs it. References show as chips with the file name, in the composer and in
messages; hover one for its path, or tap it on a phone. Backspace after a chip removes the whole reference.

Paste, drag in or attach (the paperclip) PNG, JPEG, GIF or WebP images, up to 20 MB each, to send
them with a message; a message can be just images. They upload as soon as you add them, and Send
waits until they have. The agent sees each image and is also told where it is saved, so it can use
the file itself. Click an image in the transcript to see it full size.

File paths in the transcript are links when they name a file in the thread's workspace or project
files: paths in the agent's messages (in code or plain text, absolute or relative to the workspace
or a repo, with an optional `:line` or `:start-end`), file chips, and the files of read, edit and
write tool calls. Clicking one opens it in a panel on the right, in place of the overview: text
with line numbers and the given lines highlighted, markdown rendered (with a source toggle),
images fitted to the panel, folders as a list. Drag its left edge to resize it; Escape or × closes
it. Ctrl- or Cmd-click opens the file in a new tab instead. When the agent views an image, its tool
call shows a thumbnail that opens in the same panel.

Agents can show you HTML they write, such as a chart, diagram, comparison table or mockup, with
borkcode's `show_html` tool. It renders in the transcript as a card that fits its content; open it
larger in the side panel or in a new tab from the card's buttons. A page shown from a file in the
thread's workspace or project files is live (Reload shows edits) and can load images, fonts,
scripts and data from its folder by relative URL. The page runs sandboxed: its scripts work and it
can load libraries from `https:` CDNs, but it cannot reach the rest of borkcode, your session or
anything on `http:`, and it cannot submit forms, open popups or navigate away.

In "ask" mode, Claude automatically approves ordinary edits and common filesystem commands
inside the workspace and shared project files. Edits outside those directories, protected files,
and other shell commands may still need approval. "Full" mode bypasses normal permission prompts.

When the agent asks you a question with options, in either mode, it appears above the composer.
Press an option's number to pick it, type in the composer to answer in your own words, and press
Enter to submit. Threads waiting on an answer or an approval show "Needs you" in the sidebar.

**Push & PR** in a worktree thread asks the agent to commit anything outstanding and publish
through borkcode's `open_pull_requests` tool. borkcode pushes the thread's branch under the same
name, opens one pull request per repo with changes (ready for review), and links sibling pull
requests to each other. In "ask" mode you approve the push first. Pull requests found on a thread's
branch are linked to the thread and shown beside each repo.

A thread can hand work off to a new thread when you ask it to, optionally with a different agent
or model. It writes a self-contained brief (or a project file for a long one) and the new thread
starts in its own worktree, either fresh from the base branches or from the first thread's
commits. Handed-off threads nest under the thread that started them, and that thread can check on
them, their pull requests and their latest replies. The new thread copies its parent's model
unless a rule under Settings picks another, such as Opus children at medium effort for an Opus
parent at xhigh. Rules match the parent's model, optionally its effort, and the first match wins.

A thread can also delegate and keep track: the threads it watches send each turn's final reply
back to it, and it answers their questions with a message of its own. Start a thread as a
**Captain** to have it lead a piece of work this way, asking you only for design decisions,
approvals, or when it is stuck. You can message any thread at any time, even while its agent
works: the message joins at the agent's next step, or waits for the turn to end. If threads wake
each other too often, deliveries between them pause until you resume them (limits are in
Settings).

After a thread's pull request is merged, you can keep going in the same thread. The agent syncs
the branch onto the latest base branch, dropping the merged work but keeping anything newer, and
the next Push & PR opens a fresh pull request from the same branch.

By default, agents in worktree threads commit each finished step on the thread's branch without
being asked. Turn this off under Settings. Threads in the main checkouts only commit when asked.

Each repo can have a setup command, run inside every new worktree. It receives
`BORKCODE_MAIN_REPO` (the main clone, handy for copying `.env` files), `BORKCODE_WORKSPACE`
and `BORKCODE_PROJECT`.

## Running

Requires Node 22+, pnpm, git, and the `claude` and/or `codex` CLIs logged in. `gh` is used to show
pull requests.

```sh
pnpm install
pnpm dev          # server on :4800 with Vite on :5173; open http://localhost:5173
pnpm build && pnpm start   # serves the built UI from http://localhost:4800
pnpm test
pnpm typecheck
```

The server binds to 127.0.0.1 by default and only accepts expected Host headers and same-origin
browser requests. State and files stay on the server; drafts are separate in each browser.

### Network access

Start the built app as usual, open **Settings**, and turn on **Network access**. borkcode detects
its Tailscale IPv4/IPv6 addresses and opens listeners only on those addresses. Loopback stays
available for the local UI and agents; the LAN is never exposed.

Settings lists **This machine**, **Tailscale IP**, and **Tailscale MagicDNS** URLs, with **Copy URL**
for each. Connect Tailscale on your phone or other computer and open a listed Tailscale URL.
Keep borkcode running on the main machine. No environment variables or Serve setup are required.
If Tailscale isn't available, the setting says so and checks again every 30 seconds. Switching
access off closes remote listeners and connections while keeping localhost running.

The tailnet's access rules decide who can reach the app. Anyone allowed to reach it can use your
projects and agents; there are no separate app accounts. Host headers are allowlisted from the
detected addresses and MagicDNS name. Funnel requests are refused, and `/mcp/` accepts only
direct local agent requests. Sandboxed visualization assets use a capability route; other
opaque-origin requests remain refused.

HTTP on the Tailscale IP or MagicDNS name supports image paste, attachment upload, file previews,
visualizations and copying paths/URLs. If [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)
is already configured to proxy this borkcode port, borkcode verifies the endpoint and also lists
**Tailscale HTTPS (Serve)**. HTTPS is optional; it works with the same Host and asset guards.

A phone has a menu drawer and full-screen overview, file and visualization panels. Tap outside
the drawer or use its close button. The composer follows the visible viewport above the keyboard.
Its compact model/access button opens a sheet with the full options; the new-thread form uses the
same sheet for provider, role and workspace. Empty inputs stay short and grow as you type.
Touch devices use a native textarea for predictive text, autocorrect and composition, with `@`
file picking and image paste/attachment support; references become chips in sent messages. Enter
adds a newline there; tap Send. Returning to the app or regaining the network reconnects and
reloads server state while keeping your draft.

Typing `@` also suggests this project's other active threads, matched by title. Picking one inserts
`borkcode:thread:<uuid>`: a stable reference that Claude leaves intact instead of expanding as an
`@path` file. Desktop composers and sent messages show it as a thread chip with its current title;
hover for project/status and click to open the thread. Phone composers keep the reference as text,
with chips in sent messages. Archived threads stay resolvable but are omitted from suggestions.

Agents can discover local projects through `list_projects { project? }` (repos, description when
present, shared files root and thread counts), then `list_threads { project?, include_archived?,
cursor?, limit? }`. The latter defaults to the calling project, active threads and 50 results,
ordered by recent activity with stored PR states. `read_thread { thread_id, from?, cursor?, limit? }`
defaults to the last 10 items from `end`; pages are chronological with `next_cursor` pointing older
from the end or newer from the start. It skips reasoning, summarizes tool calls, truncates each
text at 2,000 characters and caps message data at 16,000 characters per page.
`read_thread_item { thread_id, item_id, offset?, limit? }` retrieves complete text in chunks,
returning `next_offset`. All these tools are read-only and work across projects in this home.
