import assert from "node:assert/strict";
import { test } from "node:test";
import type { LinkedPullRequest } from "shared/protocol";
import { renderMarkdown } from "./markdown.ts";

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
