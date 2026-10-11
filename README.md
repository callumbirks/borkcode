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

A thread's workspace always holds every repo of its project as siblings, named exactly like in
`repos/`, so relative paths such as `../vessel` work the same everywhere. All worktrees in a
workspace share one branch, `borkcode/<thread>`. Deleting a thread removes its worktrees and keeps
the branches. A thread can also run directly in the main clones instead.

A thread starts from its first message. A small model, chosen under Settings (Codex `gpt-6-luna`
at low effort by default), names it, and the workspace and branch are named after that title.
Renaming a thread later changes only its displayed title. Model and effort can be switched
between turns from the composer.

In "ask" mode, Claude automatically approves ordinary edits and common filesystem commands
inside the workspace and shared project files. Edits outside those directories, protected files,
and other shell commands may still need approval. "Full" mode bypasses normal permission prompts.

**Push & PR** in a worktree thread asks the agent to commit anything outstanding and publish
through borkcode's `open_pull_requests` tool. borkcode pushes the thread's branch under the same
name, opens one pull request per repo with changes (ready for review), and links sibling pull
requests to each other. In "ask" mode you approve the push first. Pull requests found on a thread's
branch are linked to the thread and shown beside each repo.

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

The server binds to 127.0.0.1 and only accepts same-origin WebSocket connections.
