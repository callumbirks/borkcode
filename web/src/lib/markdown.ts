import { Marked, type TokenizerAndRendererExtension } from "marked";
import type { LinkedPullRequest } from "shared/protocol";
import { findFileReferences, type FileReference, type ReferenceRoots } from "./fileReferences.ts";
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
 * Markdown to HTML, with GitHub PR URLs and known `repo#n` references as state chips, and file
 * references into the thread's project as file chips. The output is not sanitized.
 */
export function renderMarkdown(
  text: string,
  pullRequests: LinkedPullRequest[],
  roots: ReferenceRoots | null = null,
): string {
  const index = pullRequestIndex(pullRequests);

  const fileReferenceExtension: TokenizerAndRendererExtension = {
    name: "fileReference",
    level: "inline",
    start(src) {
      return roots ? findFileReferences(src, roots)[0]?.start : undefined;
    },
    tokenizer(src) {
      if (!roots || this.lexer.state.inLink) return;
      const reference = findFileReferences(src, roots)[0];
      if (reference?.start === 0) return { type: "fileReference", raw: src.slice(0, reference.end), reference };
    },
    renderer(token) {
      const reference: FileReference = token.reference;
      return `<span class="file-chip" title="${escape(reference.label)}">${escape(reference.name)}</span>`;
    },
  };

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
    extensions: [pullRequestRefExtension, fileReferenceExtension],
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
