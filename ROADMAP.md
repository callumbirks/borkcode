# Roadmap

What borkcode has shipped and what may come next. The constraints every change works within
(providers, local or tailnet access, keeping scope small) live in the Scope section of `AGENTS.md`.

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
14. **HTML visualizations.** The agent's `show_html` tool shows HTML it writes (inline or from a
    file) as a card in the thread, sandboxed in an opaque origin, which opens larger in the
    preview panel or in a new tab. Showing it again by id replaces it.

15. **Remote and mobile over Tailscale.** A Network access toggle detects and binds only Tailscale
    addresses, lists HTTP/MagicDNS URLs and any existing Serve HTTPS endpoint, while the
    server keeps loopback, with a Host allowlist and a local-only agent MCP endpoint. Phones
    get a navigation drawer, full-screen panels, touch targets and a native keyboard composer;
    uploads, previews and visualizations use the same server routes. Reconnect on returning from
    the background or regaining the network.
16. **Mark as read or unread.** Right-click or long-press a thread in the sidebar, or use the
    thread header, to mark it read or unread, even before it has a response. A thread marked
    unread while open stays unread until you leave it. A project's menu marks all its threads read.

17. **`@` thread references.** The picker suggests other non-archived threads by title, inserting
    stable `borkcode:thread:<uuid>` references rendered as clickable thread chips. Agents discover
    projects/threads and read transcripts through bounded MCP pages, starting from the end,
    with tool summaries, skipped reasoning and complete text available in chunks.

18. **File uploads.** Attach any file to a message, from any device including a phone over the
    tailnet: paste, drop or the paperclip (which offers Files and the photo library on phones).
    Images keep native handling; other files, up to 100 MB, show as chips with name and size,
    reach agents as a saved path they read with their own tools, and download from the transcript.

## Next

1. **Convert HEIC images to PNG.** Photos from iPhones often arrive as HEIC, which agents' image
   input doesn't accept, so they currently reach agents as plain files. Convert them to PNG on
   upload so they're sent as images. First check how t3code handles HEIC and borrow its approach.

## Not planned yet

- Checkpoints/restore.
- Other providers.
- Hardware budgets and a run queue. Heavy commands such as builds and test servers take memory
  from a machine-wide budget and wait in a queue when it's full, so parallel threads don't run the
  machine out of memory. Ideas: `ideas/machine-resources.md` in the shared project files.
