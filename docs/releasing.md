# Releasing

`.github/workflows/release.yml` builds both apps, agent-terminal and agent-terminal-controller, for macOS arm64
(`.dmg`, `.zip`) and Linux x64 (`.AppImage`, `.deb`). It uploads them to a **draft** GitHub release with generated
notes. Nothing is public until you press **Publish** on the draft. A test build of a branch is the one exception: it
is published as a pre-release at once ([Test pre-release from a branch](#test-pre-release-from-a-branch)).

The workflow runs no tests. A release builds from a commit on `main`, which merged with a passing test proof
(`docs/test-proof.md`).

## Cut a release

1. **Actions → release → Run workflow** on `main`, and enter the version without the `v` (`0.2.0`, or `0.2.0-beta.1`).
   This opens a draft PR `Release v0.2.0` from the branch `release/v0.2.0`, which bumps `package.json`.
2. Check out that branch, run `pnpm run test:proof`, and mark the PR ready. Opening the PR with `GITHUB_TOKEN`
   starts no workflow. Marking it ready runs `lint`, as on any PR, and the test proof is its required check.
3. Squash-merge it. The push to `main` changes `package.json`'s version, so the workflow tags the merge commit
   `v0.2.0`, builds, and creates the draft release.
4. Review the draft on the Releases page, edit the notes if needed, and press **Publish**.

A version with a `-` suffix (`0.2.0-beta.1`) is marked **Pre-release**.

Step 1 is only a convenience. **Any** PR whose merge changes `package.json`'s version releases that version in the
same way.

### Tagging by hand

Pushing a `v*` tag also builds a draft release, from the tagged commit, which must be on `main`. Use it for a
commit whose version was never released, such as one merged before this workflow existed:

```sh
git tag v0.1.0 <sha> && git push origin v0.1.0
```

The run fails unless the tag is `v` plus `package.json`'s version at that commit. Do not tag a bump PR's commit
before it merges: that commit is not on `main`, so the tag's run fails, and the merge's run fails too because the
tag already points elsewhere. Delete the tag (`git push origin :refs/tags/v0.2.0`) and re-run the merge's run.

## Test pre-release from a branch

To try a branch's build before it merges, for example to walk the README's install steps against it, run
**Actions → release → Run workflow**, choose the branch under **Use workflow from**, and leave the version empty.
From the command line:

```sh
gh workflow run release.yml --ref <branch>
```

The run builds the same macOS arm64 and Linux x64 installers of both apps from the branch's head, tags that commit
`v<version>-branch-<branch>.<run number>` (for example `v0.1.0-branch-plan-loop-issue-299.12`), and publishes them
straight away as a **Pre-release**, not a draft, with notes that name the branch and commit. The version is
`package.json`'s, without any `-` suffix, then `-branch-`, then the branch name in lowercase with every other character
turned into `-`, then the run number. The installed apps report it. Nothing is committed to the branch, and the run
runs no tests. GitHub never marks a pre-release as the latest release, so `releases/latest` and the README's link
still point at the last real release.

The run refuses a version input (that is for `main`) and a tag selected under **Use workflow from**. Delete a test
pre-release and its tag when you are done with it: `gh release delete <tag> --cleanup-tag`.

## Re-running

Re-run the run from the Actions page, either all jobs or only the failed ones. The release job uploads the files the
build jobs left, which expire after 3 days, so after that re-run all jobs. A tag that the run already pushed
for the same commit does not stop it. When the draft release already exists, the release job replaces its assets
instead of creating a second release. Once the release is published, a re-run fails rather than replace the assets
users have downloaded. The `release/vX.Y.Z` branch and the tag both block a
second dispatch of the same version. Delete them to start over.

## One-time repository setting

The dispatch step opens its PR with `GITHUB_TOKEN`, which needs **Settings → Actions → General → Workflow
permissions → Allow GitHub Actions to create and approve pull requests**. Without it, the run still pushes the
branch, then fails with a link to open the PR by hand.

## macOS signing

The macOS apps are ad-hoc signed, not signed with a Developer ID and not notarized, so Gatekeeper blocks a
downloaded copy on first launch. Users open it through **System Settings → Privacy & Security → Open Anyway**, and
the release notes say so. Developer ID signing and notarization would replace the workflow's `-c.mac.identity=-`
with the `CSC_LINK`/`CSC_KEY_PASSWORD` and `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` secrets.
