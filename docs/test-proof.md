# Test proof — merging on a local test run

A PR merges into `main` only when its exact head commit carries a passing test proof: two commit statuses that
`pnpm run test:proof` publishes after a full local vitest run and a full Podman e2e run of that commit. GitHub
Actions runs the lint, vitest and e2e workflows on a PR into `main` once it is ready for review, and again on the
push to `main` that a merge creates, as the check that the proofs were honest. They do not run on a draft PR. To run
either on a draft PR's branch
at a point you choose, dispatch it by hand: `gh workflow run test.yml --ref <branch>` or
`gh workflow run e2e.yml --ref <branch>`. A dispatched run publishes no `test-proof/*` status, so it never stands in
for the proof.

## When to run it

Run `pnpm run test:proof` on the PR's final head commit, before the PR is marked ready for review. For a PR that is
already ready (an agent loop flips its PR to ready at plan approval, spec §27.13), run it before the PR merges.

Any new push to the PR, a merge from `main` included, gives the PR a new head commit with no proof statuses, so run
the command again on that commit.

## What it does

With no arguments, from the repository root, on a branch with an open PR:

1. It checks the preconditions below and refuses if any fails, before running a suite.
2. It runs the full vitest suite on the host, as `pnpm test` runs it (with its `pretest` hook), with a JSON report
   and retries off.
3. It runs the full Podman e2e suite, `./scripts/e2e-podman.sh`, with machine-readable results
   (`docs/e2e-podman.md` § `E2E_REPORT_DIR`). It stops after vitest if vitest fails.
4. It checks the preconditions again, and that `HEAD` did not move.
5. It publishes, on the tested commit, one `success` status per suite, whose description gives that suite's
   passed, skipped and flaky counts, and one summary comment on the PR. The summary gives the commit SHA, the
   passed, failed, skipped and flaky counts per suite, the name of every skipped and every flaky test, and the
   Node, Electron and (for e2e) Podman image identity each suite ran with. A re-run by the same GitHub login edits
   that login's summary comment instead of adding a second one.

Every refusal publishes nothing: no status is created, and no comment is created or edited. Each refusal names its
cause. Fix it and run the command again.

## Required checks

These are the status names the command publishes, and the names to add to the ruleset. They are the values of
`TEST_PROOF_CHECKS` in `src/main/testProof.ts`, and `tests/unit/testProofDocs.test.ts` fails if this list drifts
from them.

- `test-proof/vitest`
- `test-proof/e2e`

## Refusals, and why each exists

- **Any argument.** A proof is always the full run of both suites, so nothing may filter, shard or select one of
  them. A partial run's tally would read as the whole suite's.
- **A focused test** (`it.only`, `test.only`, `describe.only`). It would narrow a suite the same way, so both suites
  run with focused tests forbidden and fail if one is committed. The command then refuses that suite.
- **Not on a branch (detached `HEAD`).** The proof is for a PR, found by the branch's name.
- **A dirty working tree**: an uncommitted change, staged or not, or an untracked file that git does not ignore.
  The e2e harness bind-mounts the working tree rather than a checkout of the commit, and vitest runs on the working
  tree too, so a run only describes the commit when the tree is clean. The tree is checked again after the suites,
  so a file changed during the run also refuses.
- **No open PR from this repository for the branch.** The statuses would gate nothing, and the summary has nowhere
  to go.
- **Several open PRs from this repository for the branch.** The command cannot tell which one the proof is for.
- **Only a PR headed on a fork.** See [Fork PRs](#fork-prs). A fork PR that only shares the branch's name is
  ignored, so it never blocks this repository's own PR.
- **`gh` missing or not logged in.** The command finds the PR and publishes through `gh`.
- **`HEAD` is not the PR's head commit** (never pushed, pushed behind, or the PR moved on). A status on a commit
  that is not the PR head gates nothing, and a commit that is not pushed cannot carry one. The same check runs after
  the suites, so a push or a checkout during the run refuses.
- **A suite fails**: a failing test, an errored test file, a non-zero exit, or results the command cannot read (a
  missing or malformed report). An unreadable result is never read as a pass.

If publishing fails part-way, the command exits non-zero and says which of the two statuses and the comment it
published and which it did not. Run it again: a full re-run repeats both suites and publishes all three. There is no
publish-only mode, because it would be a proof path that skips the suites.

## Flaky tests

The e2e harness runs Playwright with `CI=1`, which retries a failing test up to 2 times. A test that passes only
after a retry is **flaky**. A flaky test counts as passing, so it does not block the proof, but each one is listed
by name in the summary comment, and each suite's flaky count is in its status description and the summary. Vitest
runs with retries off, so its flaky count is always 0.

## One-time ruleset step (operator, after this PR merges)

Apply this once, by hand. Steps 1–3 wait until the PR that adds this command has merged into `main`: applying them
earlier would gate that PR on a command `main` does not yet have. Step 4 gates nothing, so apply it **before** that
PR merges. Its squash commit is the first push to `main` whose post-merge run checks the proofs, and under the old
setting that commit's message would carry the PR's `[skip ci]` commits. When you merge it, also check that the squash
commit's title and message do not contain `[skip ci]`.

1. In the repository's **Settings → Rules → Rulesets**, open ruleset `main` (id 19993572). It is active with no
   bypass actors, but its target list is empty, so it applies to no branch today.
2. Retarget it: add the `main` branch (the default branch) to its target branches.
   Retargeting starts enforcing the rules the ruleset already holds, on `main`, for everyone, the repository owner
   included:
   - changes reach `main` only through a pull request;
   - pull requests merge by squash only;
   - `main` cannot be deleted;
   - `main` cannot be force-pushed.
3. Add the **Require status checks to pass** rule, and add both checks in [Required checks](#required-checks), by
   exact name. Leave the rule's source unrestricted ("any source"): the statuses are written with the developer's
   own `gh` login, not by a GitHub App.
4. In **Settings → General → Pull Requests**, under squash merging, set the default commit message to **Pull
   request title and description** (or **Pull request title** for a blank message).

### Why the squash commit message matters

GitHub skips every workflow for a push whose head commit message contains `[skip ci]`. The repository's draft-PR
discipline puts `[skip ci]` in the commits on a draft PR, and GitHub's default squash message joins those commit
messages. A squash commit that carries `[skip ci]` would skip the post-merge run on `main`, the only CI run of the
suites. So the squash commit takes its message from the PR title and description instead, and **a PR's title and
description must not contain `[skip ci]`**.

### Check the gate after applying it

On a PR whose head commit has no proof statuses (for example, push a new commit and do not run the command), the
PR shows both `test-proof/*` checks as expected and is blocked from merging. After the next merge, confirm that the
`test` and `e2e` workflows ran on the push to `main`.

## Fork PRs

The command refuses a PR headed on a fork. To merge a fork's change, copy its commits into a branch in this
repository, open a PR from that branch, and prove that branch. A same-named open fork PR does not block it.

That route runs the contributor's code on your machine: vitest and dependency install scripts on the host, plus the
e2e harness, the `pnpm` scripts and the command itself, all built from the checked-out tree. Review the changes
before you run it, the scripts, tests and dependency changes especially. Proving fork PRs safely is follow-up
[#285](https://github.com/dylanb/agent-terminal/issues/285).

## When the post-merge run fails

A red `test` or `e2e` run on `main` means a proof did not describe what merged, the environment drifted, or an `e2e`
shard ran out of time (its log says "Timed out waiting"). GitHub's normal failed-run notification is the alert.
Investigating it is a human job.
