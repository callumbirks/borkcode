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
4. **Per-thread drafts.** Each thread keeps its unsent chatbox text, in the browser's
   localStorage, so switching threads or reloading doesn't lose it.
5. **PR status.** Linked pull requests are polled on GitHub while open. Each thread in the sidebar
   shows icons for its open, merged and closed PRs. PR links in agent messages render as chips
   with their state. A merge or close wakes the thread that owns it, unless it's archived.
6. **Archived threads.** Threads and their subtrees can be archived out of the sidebar onto an
   Archived page, and come back when unarchived or messaged. Threads sort by recent activity, and
   working threads show a spinner in the sidebar.
7. **Unread threads.** A thread whose agent finished a turn since the user last had it open for 3
   seconds shows as unread in the sidebar. A captain's child reporting to it doesn't count.
8. **User questions.** Claude's AskUserQuestion and Codex's request_user_input show above the
   chatbox, with number keys for options and the chatbox as a free-text answer. The answer goes
   back to the tool call and stays in the transcript. Threads waiting on a question or approval
   show "Needs you" in the sidebar.
9. **Child thread model rules.** Rules in Settings pick a new child thread's model and effort from
   its parent's, matching on model alone or model and effort, first match wins. An agent's
   explicit choice still wins, and with no match the child copies its parent.
10. **`@` file references.** Typing `@` in the chatbox suggests files across all the project's
    repos, plus shared project files, narrowing as you type. Picking one puts a reference to it in
    the message.
11. **Images in the prompt.** Paste, drop or attach images in the chatbox and send them with the
    message, even with no text. They upload to the server over HTTP as thread attachments, show as
    thumbnails in the transcript, and reach Claude as image blocks and Codex as local images.
12. **Rich file paths.** File paths in agent messages, file chips and read/edit/write tool calls
    link to a resizable preview panel on the right, with line ranges highlighted and markdown
    rendered. The server serves thread files over HTTP for it, safely, so it works remotely too.
13. **Images in tool calls.** When the agent views an image file (Claude's Read, Codex's image
    view), the expanded tool call shows a thumbnail that opens full size in the preview panel.

## Next

Not prioritized yet. The order below is a suggestion.

1. **HTML visualizations.** A tool that lets the agent show HTML it writes, rendered in the
   thread, instead of the user opening a separate file.
2. **Remote and mobile over Tailscale.** Use borkcode from another device on the same tailnet while
   the server runs on the main machine. The tailnet is the access boundary, so the server only
   needs to listen beyond localhost (it already reads `HOST`). The web client needs a layout
   that works on a phone, and file previews must keep working.
3. **Mark as read or unread.** Actions to mark a thread read or unread by hand, building on the
   automatic unread indicator.
4. **`@` thread references.** `@` also suggests other threads in the project that aren't
   archived, so one thread can read through another's transcript. Builds on `@` file references.
5. **File uploads.** Attach any file to a message, not just images, from any device viewing
   borkcode, including remote ones. Builds on the attachments behind images in the prompt, and
   comes after remote and mobile access.

## Not planned yet

- Checkpoints/restore.
- Other providers.
- Hardware budgets and a run queue. Heavy commands such as builds and test servers take memory
  from a machine-wide budget and wait in a queue when it's full, so parallel threads don't run the
  machine out of memory. Ideas: `ideas/machine-resources.md` in the shared project files.
