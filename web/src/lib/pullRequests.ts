import type { LinkedPullRequest } from "shared/protocol";

export type PullRequestState = "open" | "merged" | "closed";

/** GitHub's OPEN, MERGED or CLOSED. Pair with the `pr-<state>` colour classes in app.css. */
export function pullRequestState(pr: LinkedPullRequest): PullRequestState {
  const state = pr.state.toLowerCase();
  return state === "merged" || state === "closed" ? state : "open";
}

const pullRequestUrl = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/i;
// A bare `repo#12`, not preceded by anything that would make it part of a longer word or path.
export const pullRequestRef = /(?<![\w.\/#-])([\w.-]+)#(\d+)(?![\w-])/g;

export function parsePullRequestUrl(url: string) {
  const match = pullRequestUrl.exec(url);
  return match ? { owner: match[1], repo: match[2], number: Number(match[3]) } : undefined;
}

/** Finds linked PRs by URL or by `repo#n`, where repo is the local repo name or GitHub's. */
export function pullRequestIndex(pullRequests: LinkedPullRequest[]) {
  const byKey = new Map<string, LinkedPullRequest>();
  for (const pr of pullRequests) {
    const parsed = parsePullRequestUrl(pr.url);
    if (parsed) byKey.set(`${parsed.owner}/${parsed.repo}#${pr.number}`.toLowerCase(), pr);
    for (const repo of [pr.repo, parsed?.repo]) {
      const key = `${repo}#${pr.number}`.toLowerCase();
      if (repo && !byKey.has(key)) byKey.set(key, pr);
    }
  }
  return {
    byUrl: (url: string) => {
      const parsed = parsePullRequestUrl(url);
      return parsed && byKey.get(`${parsed.owner}/${parsed.repo}#${parsed.number}`.toLowerCase());
    },
    byRef: (repo: string, number: number) => byKey.get(`${repo}#${number}`.toLowerCase()),
  };
}

