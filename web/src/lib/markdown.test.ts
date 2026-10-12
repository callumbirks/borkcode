import assert from "node:assert/strict";
import { test } from "node:test";
import type { LinkedPullRequest } from "shared/protocol";
import { renderMarkdown } from "./markdown.ts";
import { mentionedPullRequestNumbers } from "./pullRequests.ts";

const merged: LinkedPullRequest = {
  repo: "borkcode",
  number: 3,
  url: "https://github.com/callumbirks/borkcode/pull/3",
  state: "MERGED",
  title: "PR status",
  headOid: "abc",
};

const chip = (state: string, label: string, url = merged.url) =>
  `<a class="pr-chip" href="${url}" target="_blank" rel="noreferrer"><span class="pr-${state}" data-pr-state="${state}"></span>${label}</a>`;

test("PR URLs become repo#n chips with their state", () => {
  const html = renderMarkdown(`See ${merged.url} and <${merged.url}>.`, [merged]);
  assert.equal(html, `<p>See ${chip("merged", "borkcode#3")} and ${chip("merged", "borkcode#3")}.</p>\n`);
});

test("PR URLs not linked to a thread get a neutral chip", () => {
  const url = "https://github.com/someone/vessel/pull/41";
  assert.equal(renderMarkdown(url, [merged]), `<p>${chip("unknown", "vessel#41", url)}</p>\n`);
});

test("known repo#n references become chips, unknown ones stay text", () => {
  const html = renderMarkdown("Merged borkcode#3, not borkcode#4 or fooborkcode#3.", [merged]);
  assert.equal(html, `<p>Merged ${chip("merged", "borkcode#3")}, not borkcode#4 or fooborkcode#3.</p>\n`);
});

test("links with their own text keep it", () => {
  const html = renderMarkdown(`[the **PR**](${merged.url})`, [merged]);
  assert.equal(html, `<p>${chip("merged", "the <strong>PR</strong>")}</p>\n`);
});

test("code is left alone", () => {
  const html = renderMarkdown(`\`borkcode#3\` \`${merged.url}\`\n\n\`\`\`\nborkcode#3\n\`\`\``, [merged]);
  assert.ok(!html.includes("pr-chip"), html);
});

test("references inside link text are not nested links", () => {
  const html = renderMarkdown("[about borkcode#3](https://example.com)", [merged]);
  assert.equal(html, `<p><a href="https://example.com">about borkcode#3</a></p>\n`);
});

test("file references into the project become file chips, outside code", () => {
  const roots = { repos: ["borkcode"], workspace: "/w", projectFiles: "/p/files" };
  const html = renderMarkdown("Read @borkcode/src/main.ts and @/p/files/plan.md, not `@borkcode/x.ts` or @bob.", [], roots);
  assert.equal(
    html,
    '<p>Read <span class="file-chip" title="borkcode/src/main.ts">main.ts</span> and ' +
      '<span class="file-chip" title="Project files/plan.md">plan.md</span>, not <code>@borkcode/x.ts</code> or @bob.</p>\n',
  );
});

test("a message renders the same against only the PRs it mentions", () => {
  const pr = (owner: string, repo: string, number: number, state: string): LinkedPullRequest => ({
    repo,
    number,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    state,
    title: "",
    headOid: "",
  });
  // Two repos named alike with the same number: the first linked wins `vessel#5`, so order matters.
  const all = [
    merged,
    pr("someone", "vessel", 5, "OPEN"),
    pr("other", "vessel", 5, "CLOSED"),
    pr("callumbirks", "borkcode", 8, "OPEN"),
  ];
  const text = `Merged borkcode#3 and vessel#5, see https://github.com/other/vessel/pull/5 (not #12).`;
  const numbers = mentionedPullRequestNumbers(text);
  assert.deepEqual([...numbers].sort((a, b) => a - b), [3, 5, 12]);
  const mentioned = all.filter((each) => numbers.has(each.number));
  assert.equal(mentioned.length, 3);
  assert.equal(renderMarkdown(text, mentioned), renderMarkdown(text, all));
});
