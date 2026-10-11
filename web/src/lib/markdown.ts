import { Marked, type TokenizerAndRendererExtension } from "marked";
import type { LinkedPullRequest } from "shared/protocol";
import { parsePullRequestUrl, pullRequestIndex, pullRequestRef, pullRequestState } from "./pullRequests.ts";

function escape(text: string) {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * The icon is an empty placeholder because lucide's icons are Svelte components;
 * ItemView mounts them into `[data-pr-state]` after rendering.
 * "unknown" is a PR URL that isn't linked to any thread.
 */
function chip(href: string, state: string, label: string) {
  return (
    `<a class="pr-chip" href="${escape(href)}" target="_blank" rel="noreferrer">` +
    `<span class="pr-${state}" data-pr-state="${state}"></span>${label}</a>`
  );
}

/**
 * Markdown to HTML, with GitHub PR URLs and known `repo#n` references as state chips.
 * The output is not sanitized.
 */
export function renderMarkdown(text: string, pullRequests: LinkedPullRequest[]): string {
  const index = pullRequestIndex(pullRequests);

  const pullRequestRefExtension: TokenizerAndRendererExtension = {
    name: "pullRequestRef",
    level: "inline",
    start(src) {
      for (const match of src.matchAll(pullRequestRef)) {
        if (index.byRef(match[1], Number(match[2]))) return match.index;
      }
    },
    tokenizer(src) {
      if (this.lexer.state.inLink) return;
      const match = new RegExp(`^${pullRequestRef.source}`).exec(src);
      const pr = match && index.byRef(match[1], Number(match[2]));
      if (match && pr) return { type: "pullRequestRef", raw: match[0], pr };
    },
    renderer(token) {
      const pr: LinkedPullRequest = token.pr;
      return chip(pr.url, pullRequestState(pr), escape(token.raw));
    },
  };

  const marked = new Marked({
    extensions: [pullRequestRefExtension],
    renderer: {
      link(token) {
        const parsed = parsePullRequestUrl(token.href);
        if (!parsed) return false;
        const pr = index.byUrl(token.href);
        // Bare and <angle> URLs become `repo#n`; links with their own text keep it.
        if (token.text === token.href) {
          return chip(token.href, pr ? pullRequestState(pr) : "unknown", escape(`${parsed.repo}#${parsed.number}`));
        }
        if (!pr) return false;
        return chip(token.href, pullRequestState(pr), this.parser.parseInline(token.tokens));
      },
    },
  });
  return marked.parse(text, { async: false });
}
