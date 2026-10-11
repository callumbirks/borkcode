import type { Project, Thread } from "shared/protocol";

/** Workspace orientation appended to every agent's system instructions. */
export function buildInstructions(project: Project, thread: Thread, cwd: string): string {
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
  ];
  if (thread.branch) {
    lines.push(
      `Each repository is a git worktree already checked out on ${thread.branch}. Commit there rather than creating other branches, unless asked.`,
    );
  } else {
    lines.push("These are the project's main clones, shared with the user. Do not switch branches unless asked.");
  }
  lines.push(
    "When a change spans repositories, commit in each affected repository. If you open pull requests, open one per repository with changes, and link the sibling pull requests in each description.",
    `Project files shared across threads live in ${project.path}/files. You may read and write there.`,
  );
  return lines.join("\n");
}
