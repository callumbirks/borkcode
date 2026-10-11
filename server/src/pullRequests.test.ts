import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { LinkedPullRequest, RepoStatus } from "shared/protocol";
import { git } from "./exec.ts";
import {
  fastForward,
  mergedNotSynced,
  planPublish,
  planSync,
  pushBranch,
  rebasePastMerged,
  statesFromGraphql,
  withRelatedBlock,
} from "./pullRequests.ts";
import { ToolError } from "./errors.ts";

const scratch = await mkdtemp(join(tmpdir(), "borkcode-prs-"));
after(() => rm(scratch, { recursive: true, force: true }));

function status(name: string, ahead: number, changedFiles: string[] = [], path = `/ws/${name}`): RepoStatus {
  return { name, path, exists: true, branch: "borkcode/t", baseBranch: "main", changedFiles, ahead };
}

function pr(repo: string, number: number, state = "OPEN", headOid = "abc123"): LinkedPullRequest {
  return { repo, number, url: `https://github.com/me/${repo}/pull/${number}`, state, title: `PR ${number}`, headOid };
}

const BRANCH = "borkcode/fix-t1";

/** A bare origin with an initial commit on main, and a clone on the thread branch. */
async function makeRepo(name: string): Promise<{ origin: string; clone: string }> {
  const origin = join(scratch, `${name}.git`);
  const clone = join(scratch, name);
  await git(scratch, "init", "-q", "--bare", "-b", "main", origin);
  await git(scratch, "clone", "-q", origin, clone);
  await git(clone, "config", "user.email", "test@example.com");
  await git(clone, "config", "user.name", "test");
  await writeFile(join(clone, "app.txt"), "one\n");
  await git(clone, "add", ".");
  await git(clone, "commit", "-q", "-m", "init");
  await git(clone, "push", "-q", "origin", "main");
  await git(clone, "switch", "-q", "-c", BRANCH);
  return { origin, clone };
}

async function commit(dir: string, file: string, content: string, message: string): Promise<string> {
  await writeFile(join(dir, file), content);
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

/** Lands the branch's changes on origin/main as a single squash commit, as GitHub does. */
async function squashMerge(clone: string, base: string): Promise<void> {
  const head = await git(clone, "rev-parse", "HEAD");
  await git(clone, "switch", "-q", "--detach", base);
  await git(clone, "merge", "-q", "--squash", head);
  await git(clone, "commit", "-q", "-m", "Squashed PR");
  await git(clone, "push", "-q", "origin", "HEAD:main");
  await git(clone, "switch", "-q", BRANCH);
  await git(clone, "fetch", "-q", "origin");
}

test("publishing opens PRs for repos ahead, pushes to open ones, and skips the rest", () => {
  const steps = planPublish(
    [status("alpha", 2), status("beta", 1), status("gamma", 0)],
    [{ repo: "alpha", title: "Add login", body: "Adds login." }],
    [pr("beta", 7), pr("alpha", 3, "MERGED", "merged-head")],
    new Map(),
  );
  assert.deepEqual(
    steps.map((step) => [step.repo, step.action, step.lease]),
    [
      ["alpha", "open", "merged-head"],
      ["beta", "push", null],
    ],
  );
});

test("publishing refuses with every problem listed at once", () => {
  assert.throws(
    () =>
      planPublish(
        [status("alpha", 2, [" M src/app.ts"]), status("beta", 1), status("gamma", 0), status("delta", 3)],
        [
          { repo: "gamma", title: "Nothing", body: "Nothing." },
          { repo: "epsilon", title: "Unknown", body: "Unknown." },
          { repo: "delta", title: "More", body: "More." },
        ],
        [pr("delta", 9, "MERGED")],
        new Map([["delta", pr("delta", 9, "MERGED")]]),
      ),
    (error: Error) => {
      assert.ok(error instanceof ToolError);
      assert.match(error.message, /alpha has uncommitted changes/);
      assert.match(error.message, /M src\/app\.ts/);
      assert.match(error.message, /gamma has no commits ahead of main/);
      assert.match(error.message, /no repository named epsilon/);
      assert.match(error.message, /beta has 1 commits ahead of main and no open pull request/);
      assert.match(error.message, /delta: pull request #9 was merged; call sync_with_base/);
      return true;
    },
  );
});

test("syncing rebases merged repos, fast-forwards untouched ones, keeps the rest, and refuses when dirty", () => {
  const steps = planSync(
    [status("alpha", 3), status("beta", 0), status("gamma", 2)],
    new Map([["alpha", pr("alpha", 3, "MERGED")]]),
  );
  assert.deepEqual(
    steps.map((step) => [step.repo, step.action]),
    [
      ["alpha", "rebase"],
      ["beta", "fast-forward"],
      ["gamma", "keep"],
    ],
  );
  assert.throws(() => planSync([status("alpha", 1, ["?? notes.txt"])], new Map()), /alpha has uncommitted changes/);
});

test("the related block is added, replaced in place of the old one, and removed", () => {
  const once = withRelatedBlock("Adds login.", [pr("beta", 7)]);
  assert.match(once, /^Adds login\.\n\n<!-- borkcode:related -->/);
  assert.match(once, /- beta: https:\/\/github.com\/me\/beta\/pull\/7/);
  const twice = withRelatedBlock(`${once}\n\nEdited after.`, [pr("beta", 7), pr("gamma", 2)]);
  assert.equal(twice.match(/<!-- borkcode:related -->/g)?.length, 1);
  assert.match(twice, /^Adds login\.\n\nEdited after\.\n\n<!-- borkcode:related -->/);
  assert.match(twice, /- gamma:/);
  assert.equal(withRelatedBlock(twice, []), "Adds login.\n\nEdited after.");
  assert.equal(withRelatedBlock(once, [pr("beta", 7)]), once);
});

test("pushing publishes the branch under its own name and never forces without a lease", async () => {
  const { origin, clone } = await makeRepo("push");
  await commit(clone, "fix.txt", "fix\n", "fix");
  await pushBranch(clone, BRANCH, null);
  assert.equal(await git(origin, "rev-parse", BRANCH), await git(clone, "rev-parse", "HEAD"));
  assert.equal(await git(clone, "rev-parse", "--abbrev-ref", "@{upstream}"), `origin/${BRANCH}`);

  await git(clone, "commit", "-q", "--amend", "-m", "rewritten");
  await assert.rejects(pushBranch(clone, BRANCH, null), /rejected|non-fast-forward|fetch first/);
});

test("after a squash merge, syncing keeps only later commits and the next push replaces the merged branch", async () => {
  const { origin, clone } = await makeRepo("squash");
  await commit(clone, "app.txt", "one\ntwo\n", "part one");
  const mergedHead = await commit(clone, "app.txt", "one\ntwo\nthree\n", "part two");
  await pushBranch(clone, BRANCH, null);
  await squashMerge(clone, "origin/main");
  // A follow-up made before anyone synced.
  await commit(clone, "follow.txt", "follow-up\n", "follow-up");

  const linked = [pr("squash", 1, "MERGED", mergedHead)];
  assert.deepEqual([...(await mergedNotSynced([status("squash", 3, [], clone)], linked)).keys()], ["squash"]);

  assert.deepEqual(await rebasePastMerged(clone, "main", mergedHead), []);
  assert.equal(await git(clone, "log", "--format=%s", "origin/main..HEAD"), "follow-up");
  assert.equal(await readFile(join(clone, "app.txt"), "utf8"), "one\ntwo\nthree\n");
  assert.equal((await mergedNotSynced([status("squash", 1, [], clone)], linked)).size, 0);

  // The remote branch still holds the merged commits; only exactly those may be overwritten.
  await pushBranch(clone, BRANCH, mergedHead);
  assert.equal(await git(origin, "rev-parse", BRANCH), await git(clone, "rev-parse", "HEAD"));
});

test("after a merge-commit merge, new work on the base publishes without syncing", async () => {
  const { origin, clone } = await makeRepo("mergecommit");
  const mergedHead = await commit(clone, "app.txt", "one\ntwo\n", "feature");
  await pushBranch(clone, BRANCH, null);
  await git(clone, "switch", "-q", "--detach", "origin/main");
  await git(clone, "merge", "-q", "--no-ff", "-m", "Merge PR", mergedHead);
  await git(clone, "push", "-q", "origin", "HEAD:main");
  await git(clone, "switch", "-q", BRANCH);
  await git(clone, "fetch", "-q", "origin");
  await git(clone, "reset", "-q", "--hard", "origin/main");
  await commit(clone, "follow.txt", "follow-up\n", "follow-up");

  const linked = [pr("mergecommit", 1, "MERGED", mergedHead)];
  const unsynced = await mergedNotSynced([status("mergecommit", 1, [], clone)], linked);
  assert.equal(unsynced.size, 0);
  assert.deepEqual(
    planSync([status("mergecommit", 1, [], clone)], unsynced).map((step) => step.action),
    ["keep"],
  );
  await pushBranch(clone, BRANCH, mergedHead);
  assert.equal(await git(origin, "rev-parse", BRANCH), await git(clone, "rev-parse", "HEAD"));
});

test("a leased push still refuses to overwrite commits someone else pushed", async () => {
  const { clone } = await makeRepo("lease");
  const mergedHead = await commit(clone, "a.txt", "a\n", "a");
  await pushBranch(clone, BRANCH, null);
  const other = join(scratch, "lease-other");
  await git(scratch, "clone", "-q", "--branch", BRANCH, join(scratch, "lease.git"), other);
  await git(other, "config", "user.email", "other@example.com");
  await git(other, "config", "user.name", "other");
  await commit(other, "b.txt", "b\n", "someone else");
  await git(other, "push", "-q", "origin", BRANCH);

  await git(clone, "reset", "-q", "--hard", "origin/main");
  await commit(clone, "c.txt", "c\n", "follow-up");
  await assert.rejects(pushBranch(clone, BRANCH, mergedHead), /stale info|rejected/);
});

test("a conflicting sync leaves the branch untouched and names the files", async () => {
  const { clone } = await makeRepo("conflict");
  const mergedHead = await commit(clone, "app.txt", "one\nmine\n", "mine");
  await squashMerge(clone, "origin/main");
  // Main moves on in a way that clashes with the follow-up.
  await git(clone, "switch", "-q", "--detach", "origin/main");
  await commit(clone, "app.txt", "one\nmine\ntheirs\n", "theirs");
  await git(clone, "push", "-q", "origin", "HEAD:main");
  await git(clone, "switch", "-q", BRANCH);
  await git(clone, "fetch", "-q", "origin");
  const before = await commit(clone, "app.txt", "one\nmine\nfollow-up\n", "follow-up");

  assert.deepEqual(await rebasePastMerged(clone, "main", mergedHead), ["app.txt"]);
  assert.equal(await git(clone, "rev-parse", "HEAD"), before);
  assert.equal(await git(clone, "status", "--porcelain"), "");
});

test("fast-forwarding moves an untouched branch to the latest base", async () => {
  const { clone } = await makeRepo("ff");
  await git(clone, "switch", "-q", "main");
  await commit(clone, "new.txt", "new\n", "upstream change");
  await git(clone, "push", "-q", "origin", "main");
  await git(clone, "switch", "-q", BRANCH);
  await fastForward(clone, "main");
  assert.equal(await git(clone, "rev-parse", "HEAD"), await git(clone, "rev-parse", "origin/main"));
});

test("a pull request GitHub cannot resolve does not hide the others in its repository's answer", () => {
  // What `gh api graphql` prints, before exiting with an error, when one of the numbers is gone.
  const output = JSON.stringify({
    data: { repository: { pr3: { state: "MERGED", title: "Three", headRefOid: "c3" }, pr99999: null } },
    errors: [{ type: "NOT_FOUND", path: ["repository", "pr99999"], message: "Could not resolve to a PullRequest with the number of 99999." }],
  });
  const three = { url: "https://github.com/me/alpha/pull/3", number: 3 };
  const missing = { url: "https://github.com/me/alpha/pull/99999", number: 99999 };
  assert.deepEqual(
    [...statesFromGraphql(output, [three, missing])],
    [[three.url, { state: "MERGED", title: "Three", headOid: "c3" }]],
  );
  assert.equal(statesFromGraphql("gh: not logged in", [three]).size, 0);
});
