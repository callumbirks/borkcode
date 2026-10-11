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

Not prioritized yet. The order below is a suggestion.

1. **Per-thread drafts.** Keep each thread's unsent chatbox text so switching threads doesn't lose
   it.
2. **Rich file paths.** File paths in the thread become links that open a preview in a sidebar. The
   server serves workspace files over HTTP for this, which the next three items reuse.
3. **Images in tool calls.** When the agent views an image file, the expanded tool call shows the
   image instead of a "not a text file" message. Open question: render it in the thread, in the
   sidebar, or as a thumbnail in the thread that opens in the sidebar.
4. **HTML visualizations.** A tool that lets the agent show HTML it writes, rendered in the
   thread, instead of the user opening a separate file.
5. **Remote and mobile over Tailscale.** Use borkcode from another device on the same tailnet while
   the server runs on the main machine. The tailnet is the access boundary, so the server only
   needs to listen beyond localhost (it already reads `HOST`). The web client needs a layout
   that works on a phone, and file previews must keep working.

## Not planned yet

- Checkpoints/restore.
- Other providers.
