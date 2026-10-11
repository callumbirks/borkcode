# Roadmap

What borkcode has shipped and what may come next. The constraints every change works within
(providers, local only, keeping scope small) live in the Scope section of `AGENTS.md`.

## Done

1. **Multi-repo projects and workspaces.** A project groups several repos, and each thread gets a
   workspace holding one checkout of every repo as siblings.
2. **Shared project files.** Specs, plans and notes that the user and every thread can read, with
   agent tools to list, read and write them.
3. **Captain threads.** A captain delegates to child threads and sees their PRs. This includes
   handoffs, watched delegation (children report back, parents answer with `send_to_thread`) and
   delegation limits.

## Next

Nothing decided yet.

## Later

- **Remote access.** The server owns all state and the client only renders it, so this stays cheap
  to add.

## Not planned yet

- Checkpoints/restore.
- Mobile.
- Other providers.
