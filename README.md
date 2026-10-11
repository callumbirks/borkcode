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
