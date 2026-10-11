import type { Project, Settings, Thread } from "shared/protocol";

/** Workspace orientation appended to every agent's system instructions. */
export function buildInstructions(project: Project, thread: Thread, cwd: string, settings: Settings): string {
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
    `The project has shared files, such as notes, specs and plans, that every thread of this project and the user can read and write. They live in ${project.path}/files. Use the borkcode list_project_files, read_project_file and write_project_file tools, or your own file tools at that path. Check them when the user refers to a spec, plan or note, and write there when asked to leave something for other threads.`,
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
    "## Handing off to other threads",
    "When the user asks you to hand work off to a new thread, use the borkcode start_thread tool. Only start threads when asked.",
    "The new thread sees only your message, so make it self-contained. For a long brief, write it to a project file first and tell the new thread to read it.",
    thread.branch
      ? "Use start_from this_branch to continue your own work with fresh context, and base for separate work."
      : "You work in the main checkouts, so new threads start from each repository's base branch.",
    "list_child_threads shows the threads you started, their pull requests and their latest replies.",
  );
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
