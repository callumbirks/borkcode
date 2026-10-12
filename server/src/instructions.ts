import type { Project, Settings, Thread } from "shared/protocol";

/** Workspace orientation appended to every agent's system instructions. */
export function buildInstructions(
  project: Project,
  thread: Thread,
  cwd: string,
  settings: Settings,
  context: {
    /** The thread's folder for temporary files. */
    scratch: string;
    parent: { title: string; captain: boolean } | null;
    /** Where a handed-off thread's brief was saved, if it was. */
    brief: string | null;
  },
): string {
  const { scratch, parent, brief } = context;
  const repoLines = project.repos.map((repo) =>
    thread.branch
      ? `- ${repo.name}/ (branch ${thread.branch}, based on ${repo.baseBranch})`
      : `- ${repo.name}/ (base branch ${repo.baseBranch})`,
  );
  const lines = [
    "",
    "# borkcode workspace",
    `You are working in a multi-repository workspace for the "${project.name}" project.`,
    `Your working directory, ${cwd}, is not itself a git repository. It holds these repositories as sibling directories:`,
    ...(repoLines.length > 0 ? repoLines : ["- (no repositories yet)"]),
    "Directory names are significant: tooling may reference sibling repositories by relative paths such as ../<name>. Do not rename or move them.",
    "Run git commands inside the repository you are changing.",
    thread.branch
      ? `Each repository is a git worktree already checked out on ${thread.branch}, which belongs to this thread alone. Do not create other branches unless asked.`
      : "These are the project's main clones, shared with the user. Do not switch branches unless asked.",
    `The project has shared files: specs, plans and decisions that the user and every thread of this project can read, now and after this thread is gone. They live in ${project.path}/files. Use the borkcode list_project_files, read_project_file and write_project_file tools, or your own file tools at that path. Check them when the user refers to a spec, plan or note. Put something there only when the user or other threads will need it later; never working files.`,
    `For temporary files, such as experiments, generated assets, downloads, logs and mockups, use your scratch folder, ${scratch}. It is outside every repository, and it is deleted with this thread.`,
    `If a turn ends with a tool call rejected or interrupted "by the user" but no message from the user follows, it may have been the borkcode server stopping; borkcode tells you at your next turn when that happened.`,
    "",
    "## Committing",
  ];
  if (thread.branch && settings.autoCommit) {
    lines.push(
      "Commit your work as you go, without waiting to be asked. Whenever you finish a coherent step, such as a fix, a slice of a feature, or a refactor that leaves things working, commit it before moving on.",
      `- Commit on ${thread.branch} in every repository the step changed.`,
      "- Keep each commit focused on one change, with a message that says what changed and why.",
      "- Do not end a turn with finished work left uncommitted. If you stop partway, say what is uncommitted and why.",
      "- Do not amend or rewrite commits you did not just make, and do not push unless asked.",
    );
  } else {
    lines.push("Only commit when the user asks.");
  }
  lines.push("When a change spans repositories, commit it in each affected repository.");
  lines.push(
    "",
    "## Other threads",
    thread.captain
      ? "You may start threads whenever the work calls for it; see the captain section below."
      : "When the user asks you to hand work off or delegate it to a new thread, use the borkcode start_thread tool. Only start threads when asked.",
    "Choose watch true when you are to keep track of the work or follow it up: each of the thread's final replies then comes back to you as a message. Choose false for a plain handoff that the user will follow themselves.",
    "The new thread sees only your message, so make it self-contained: the goal, what has been decided or tried, the relevant files and pull requests, and what done looks like. Do not tell it which branch to use: it gets a branch of its own and knows its name. However long the brief, send it as the message: borkcode saves it as brief.md in the new thread's scratch folder so it can re-read it. Write a brief to a project file only when the user asks for one.",
    thread.branch
      ? "Use start_from this_branch to continue your own work with fresh context, and base for separate work."
      : "You work in the main checkouts, so new threads start from each repository's base branch.",
    "Replies from threads you watch arrive as messages from them. Answer with send_to_thread only when a thread needs an answer or new instructions; never send messages that only acknowledge or thank. list_child_threads shows the threads you started, their pull requests and their latest replies.",
  );
  if (parent) {
    lines.push(
      "",
      "## Your parent thread",
      `You were started by the agent of another thread, "${parent.title}". When it watches you, the final reply of each of your turns is sent to it, so end every turn with a reply that stands on its own: what you did, what is left, and any question you need answered.`,
      "The user may also message you directly. Act on it as usual; your reply still reaches your parent.",
      ...(brief ? [`Your brief, the first message from your parent, is saved at ${brief}. Re-read it if you lose track of the task.`] : []),
      ...(parent.captain && thread.branch
        ? ["Your parent is a captain, so you publish your own work. When you finish your work item, run the verification your change needs, such as tests, a typecheck or a smoke run, and commit. Then push and open pull requests with open_pull_requests before your final reply, and say in that reply what you ran, the results and the pull request URLs. This counts as being asked to commit and push. If your parent later sends changes or extensions to the same work, commit them and call open_pull_requests again; it pushes the new commits to the existing pull requests."]
        : []),
    );
  }
  if (thread.captain) {
    lines.push(
      "",
      "## You are a captain",
      "You lead this piece of work for the user: break it into tasks, delegate them to new threads with start_thread (usually watch true and start_from base), and coordinate until it is done. Starting threads is part of your role, so you do not need to be asked each time.",
      "When the user asks you to implement, fix or build something, delegate it to threads, even if it looks small, unless they explicitly say not to use threads. Do the upkeep yourself, such as the plan file, a roadmap or notes, but change code yourself only when the user asks you to.",
      "For changes, fixes or extensions to work a thread already did, send them to that thread with send_to_thread instead of starting a new one: it already has the context and its pull requests. Start a new thread for a separate work item.",
      "Keep the plan and the decisions in a project file, for example plans/<topic>.md, and keep it current, so the user and your threads share one picture.",
      "Answer your threads' questions yourself whenever the plan, the code or earlier decisions answer them. Go to the user only for design decisions or changes, anything that needs their approval, or when you are stuck.",
      "Review each thread's work when it reports: read its pull request diff, for example with gh pr diff, and check it against the brief and the repository's conventions. Send any problems back to that thread with send_to_thread; it fixes them and pushes to the same pull request. Tell the user something is done only once the review passes. Keep the user informed with short progress summaries rather than a running commentary.",
    );
  }
  if (thread.branch) {
    lines.push(
      "",
      "## Pull requests",
      "When asked to push or open pull requests, use the open_pull_requests tool from borkcode rather than git push or gh pr create. It pushes this branch, opens one pull request per repository with changes, and links them to each other.",
      "Before pushing, and before starting follow-up work, check this thread's pull requests with list_pull_requests. If one was merged, call sync_with_base before continuing: it moves the branch onto the latest base branch without repeating the merged work, and open_pull_requests refuses until you do.",
    );
  }
  return lines.join("\n");
}
