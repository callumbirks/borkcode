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

## Next

Not prioritized yet. The order below is a suggestion.

1. **Child thread model rules.** Rules in Settings that pick a new child thread's model and effort
   from its parent's, e.g. Opus 5.5 XHigh parents start Opus 5.5 Medium children, and GPT 6 Astra
   parents at any effort start GPT 6.1 Sol High children. Today a child copies its parent's model
   and effort unless the agent asks for others. A rule would replace that copying, and an
   agent's explicit choice would still win. A rule matches on the parent's model alone or on
   model and effort, and the first matching rule applies. With no match, the child copies its
   parent as now.
2. **`@` file references.** Typing `@` in the chatbox suggests files across all the project's
   repos, plus shared project files, narrowing as you type. Picking one puts a reference to it in
   the message, as in other harnesses.
3. **Images in the prompt.** Paste images and screenshots into the chatbox and send them with the
   message.
4. **Rich file paths.** File paths in the thread become links that open a preview in a sidebar. The
   server serves workspace files over HTTP for this, which the next three items reuse.
5. **Images in tool calls.** When the agent views an image file, the expanded tool call shows the
   image instead of a "not a text file" message. Open question: render it in the thread, in the
   sidebar, or as a thumbnail in the thread that opens in the sidebar.
6. **HTML visualizations.** A tool that lets the agent show HTML it writes, rendered in the
   thread, instead of the user opening a separate file.
7. **Remote and mobile over Tailscale.** Use borkcode from another device on the same tailnet while
   the server runs on the main machine. The tailnet is the access boundary, so the server only
   needs to listen beyond localhost (it already reads `HOST`). The web client needs a layout
   that works on a phone, and file previews must keep working.
8. **Mark as read or unread.** Actions to mark a thread read or unread by hand, building on the
   automatic unread indicator.
9. **`@` thread references.** `@` also suggests other threads in the project that aren't
    archived, so one thread can read through another's transcript. Builds on `@` file references.

## Not planned yet

- Checkpoints/restore.
- Other providers.
