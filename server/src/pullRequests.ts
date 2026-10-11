import type { LinkedPullRequest, RepoStatus } from "shared/protocol";
import { ToolError } from "./errors.ts";
import { git, run } from "./exec.ts";

export interface PullRequestDraft {
  repo: string;
  title: string;
  body: string;
}

interface StepBase {
  repo: string;
  path: string;
  base: string;
  ahead: number;
  /** Head of a merged pull request the remote branch may still hold; only that may be overwritten. */
  lease: string | null;
}

/** What publishing does in one repository. */
export type PublishStep =
  | (StepBase & { action: "open"; title: string; body: string })
  | (StepBase & { action: "push"; pullRequest: LinkedPullRequest });


function latestPullRequest(linked: LinkedPullRequest[], repo: string): LinkedPullRequest | undefined {
  return linked.filter((pr) => pr.repo === repo).at(-1);
}

async function containsCommit(repoDir: string, oid: string, ref = "HEAD"): Promise<boolean> {
  if (!oid) return false;
  return git(repoDir, "merge-base", "--is-ancestor", oid, ref).then(
    () => true,
    () => false,
  );
}

/**
 * Repos whose latest pull request was merged while the branch still carries the merged commits.
 * Those need syncing before more work is published, or the merged work would be repeated.
 * A merge commit puts the merged head into the base itself, so a branch built on the base
 * carries it without repeating anything. A stale `origin/<base>` can only report a false
 * positive here, which syncing clears because it fetches first.
 */
export async function mergedNotSynced(
  statuses: RepoStatus[],
  linked: LinkedPullRequest[],
): Promise<Map<string, LinkedPullRequest>> {
  const result = new Map<string, LinkedPullRequest>();
  for (const status of statuses) {
    const latest = latestPullRequest(linked, status.name);
    if (
      status.exists &&
      latest?.state === "MERGED" &&
      (await containsCommit(status.path, latest.headOid)) &&
      !(await containsCommit(status.path, latest.headOid, `origin/${status.baseBranch}`))
    ) {
      result.set(status.name, latest);
    }
  }
  return result;
}

/**
 * Works out what to push and open, or throws a ToolError listing every problem at once so the
 * agent can fix them in one go.
 */
export function planPublish(
  statuses: RepoStatus[],
  drafts: PullRequestDraft[],
  linked: LinkedPullRequest[],
  unsynced: Map<string, LinkedPullRequest>,
): PublishStep[] {
  const problems = uncommittedProblems(statuses);
  for (const [repo, pr] of unsynced) {
    problems.push(`${repo}: pull request #${pr.number} was merged; call sync_with_base before publishing more work.`);
  }
  const draftFor = new Map(drafts.map((draft) => [draft.repo, draft]));
  for (const draft of drafts) {
    const status = statuses.find((candidate) => candidate.name === draft.repo);
    if (!status) problems.push(`There is no repository named ${draft.repo}.`);
    else if (!status.ahead) problems.push(`${draft.repo} has no commits ahead of ${status.baseBranch}; leave it out.`);
  }
  const steps: PublishStep[] = [];
  for (const status of statuses) {
    if (!status.exists || !status.ahead) continue;
    const latest = latestPullRequest(linked, status.name);
    const common = {
      repo: status.name,
      path: status.path,
      base: status.baseBranch,
      ahead: status.ahead,
      lease: latest?.state === "MERGED" ? latest.headOid || null : null,
    };
    const open = linked.find((pr) => pr.repo === status.name && pr.state === "OPEN");
    const draft = draftFor.get(status.name);
    if (open) {
      steps.push({ ...common, action: "push", pullRequest: open });
    } else if (draft?.title.trim() && draft.body.trim()) {
      steps.push({ ...common, action: "open", title: draft.title.trim(), body: draft.body.trim() });
    } else {
      problems.push(`${status.name} has ${status.ahead} commits ahead of ${status.baseBranch} and no open pull request; give it a title and body.`);
    }
  }
  if (problems.length > 0) throw new ToolError(problems.join("\n\n"));
  return steps;
}

function uncommittedProblems(statuses: RepoStatus[]): string[] {
  return statuses
    .filter((status) => status.changedFiles.length > 0)
    .map((status) => `${status.name} has uncommitted changes; commit them first:\n${status.changedFiles.join("\n")}`);
}

/** What syncing does in one repository. */
export type SyncStep =
  | { repo: string; path: string; base: string; action: "rebase"; merged: LinkedPullRequest }
  | { repo: string; path: string; base: string; action: "fast-forward" }
  | { repo: string; action: "keep"; reason: string };

/** Expects statuses computed after fetching, so `ahead` is measured against the latest base. */
export function planSync(statuses: RepoStatus[], unsynced: Map<string, LinkedPullRequest>): SyncStep[] {
  const problems = uncommittedProblems(statuses);
  if (problems.length > 0) throw new ToolError(problems.join("\n\n"));
  return statuses
    .filter((status) => status.exists)
    .map((status): SyncStep => {
      const common = { repo: status.name, path: status.path, base: status.baseBranch };
      const merged = unsynced.get(status.name);
      if (merged) return { ...common, action: "rebase", merged };
      if (status.ahead === 0) return { ...common, action: "fast-forward" };
      return { repo: status.name, action: "keep", reason: `${status.ahead ?? "some"} commits not merged yet` };
    });
}

/**
 * Replays only the commits made after the merged head onto the latest base. A plain rebase would
 * try to reapply the merged commits too, which conflicts after a squash merge. On conflict the
 * rebase is aborted, leaving the branch as it was, and the conflicting files are returned.
 */
export async function rebasePastMerged(repoDir: string, base: string, mergedHead: string): Promise<string[]> {
  try {
    await git(repoDir, "rebase", "--onto", `origin/${base}`, mergedHead);
    return [];
  } catch (error) {
    const conflicts = (await git(repoDir, "diff", "--name-only", "--diff-filter=U").catch(() => ""))
      .split("\n")
      .filter(Boolean);
    await git(repoDir, "rebase", "--abort").catch(() => undefined);
    if (conflicts.length === 0) throw error;
    return conflicts;
  }
}

export async function fastForward(repoDir: string, base: string): Promise<void> {
  await git(repoDir, "merge", "--ff-only", "--quiet", `origin/${base}`);
}

export function describeStep(step: PublishStep, branch: string): string {
  const commits = `${step.ahead} commit${step.ahead === 1 ? "" : "s"}`;
  return step.action === "open"
    ? `${step.repo}: push ${commits} to ${branch} and open "${step.title}" against ${step.base}`
    : `${step.repo}: push ${commits} to ${branch}, updating #${step.pullRequest.number}`;
}

const RELATED_START = "<!-- borkcode:related -->";
const RELATED_END = "<!-- /borkcode:related -->";

/** Replaces the description's related pull requests block, or removes it when there are none. */
export function withRelatedBlock(body: string, related: LinkedPullRequest[]): string {
  const pattern = new RegExp(`\\s*${RELATED_START}[\\s\\S]*?${RELATED_END}\\s*`, "g");
  const stripped = body.replace(pattern, "\n\n").trim();
  if (related.length === 0) return stripped;
  const lines = related.map((pr) => `- ${pr.repo}: ${pr.url}`);
  return [stripped, "", RELATED_START, "**Related pull requests**", "", ...lines, RELATED_END].join("\n").trim();
}

/**
 * Pushes the branch under the same name. After a sync, the remote branch may still hold a merged
 * pull request's commits; only then, and only if it holds exactly those, is it overwritten.
 * Anything else on the remote makes the push fail.
 */
export async function pushBranch(repoDir: string, branch: string, lease: string | null): Promise<void> {
  const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
  try {
    await git(repoDir, "push", "--set-upstream", "origin", refspec);
  } catch (error) {
    if (!lease) throw error;
    await git(repoDir, "push", "--set-upstream", `--force-with-lease=refs/heads/${branch}:${lease}`, "origin", refspec);
  }
}

export async function createPullRequest(
  repoDir: string,
  options: { repo: string; base: string; branch: string; title: string; body: string },
): Promise<LinkedPullRequest> {
  const headOid = await git(repoDir, "rev-parse", "HEAD");
  const output = await run(
    "gh",
    ["pr", "create", "--base", options.base, "--head", options.branch, "--title", options.title, "--body", options.body],
    { cwd: repoDir },
  );
  const url = output.split("\n").at(-1)!.trim();
  const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
  if (!number) throw new Error(`gh did not print a pull request URL: ${output}`);
  return { repo: options.repo, number, url, state: "OPEN", title: options.title, headOid };
}

/** Updates a pull request's related block. Leaves the description alone when nothing changed. */
export async function linkRelated(repoDir: string, pr: LinkedPullRequest, related: LinkedPullRequest[]): Promise<void> {
  const body = await run("gh", ["pr", "view", pr.url, "--json", "body", "--jq", ".body"], { cwd: repoDir });
  const next = withRelatedBlock(body, related);
  if (next !== body.trim()) await run("gh", ["pr", "edit", pr.url, "--body", next], { cwd: repoDir });
}

/** The latest pull request whose head is the branch, in any state. */
export async function findPullRequest(repo: string, repoDir: string, branch: string): Promise<LinkedPullRequest | null> {
  try {
    const output = await run(
      "gh",
      ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "number,url,state,title,headRefOid"],
      { cwd: repoDir },
    );
    const [pr] = JSON.parse(output) as (Omit<LinkedPullRequest, "repo" | "headOid"> & { headRefOid: string })[];
    if (!pr) return null;
    const { headRefOid, ...rest } = pr;
    return { repo, ...rest, headOid: headRefOid };
  } catch {
    // Not a GitHub remote, gh missing, or offline. Discovery is best-effort.
    return null;
  }
}

/** What can change about a linked pull request after it is opened. */
export type PullRequestState = Pick<LinkedPullRequest, "state" | "title" | "headOid">;

/**
 * The current state of each pull request, with one GitHub query per repository. Repositories that
 * cannot be asked (offline, gh missing, not GitHub) are left out, to be tried again later.
 */
export async function fetchPullRequestStates(urls: string[]): Promise<Map<string, PullRequestState>> {
  const repositories = new Map<string, { host: string; owner: string; name: string; prs: { url: string; number: number }[] }>();
  for (const url of urls) {
    const match = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
    if (!match) continue;
    const [, host, owner, name, number] = match as unknown as [string, string, string, string, string];
    const key = `${host}/${owner}/${name}`;
    const repository = repositories.get(key) ?? { host, owner, name, prs: [] };
    repository.prs.push({ url, number: Number(number) });
    repositories.set(key, repository);
  }
  const states = new Map<string, PullRequestState>();
  await Promise.all(
    [...repositories.values()].map(async ({ host, owner, name, prs }) => {
      const fields = prs.map(({ number }) => `pr${number}: pullRequest(number: ${number}) { state title headRefOid }`);
      const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields.join(" ")} } }`;
      try {
        const output = await run("gh", ["api", "graphql", "--hostname", host, "-f", `query=${query}`], { timeoutMs: 15_000 });
        const found = (JSON.parse(output) as {
          data: { repository: Record<string, { state: string; title: string; headRefOid: string } | null> };
        }).data.repository;
        for (const { url, number } of prs) {
          const pr = found[`pr${number}`];
          if (pr) states.set(url, { state: pr.state, title: pr.title, headOid: pr.headRefOid });
        }
      } catch {
        // Best-effort, like discovery; the next poll tries again.
      }
    }),
  );
  return states;
}
