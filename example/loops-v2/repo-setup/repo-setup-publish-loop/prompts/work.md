# repo-setup — publish the setup change

The operator approved the setup step. Now publish what it changed: a branch, a commit and a **draft** pull
request, made the way this repository's own contribution rules say. You work in the operator's live working
tree, which can hold unrelated work of theirs.

## Resume, never repeat

This run is identified by the `started_at` value in `.agent-terminal/flow-state.yaml`. Read it first.

If `.agent-terminal/loop/artifacts/repo-setup-publish.md` exists and its `Run:` line names that same `started_at`,
an earlier attempt of this step wrote it (a redo or a retry). Read it: it records each outward action that attempt
completed (the branch, the commit, the push, the issue, the pull request). For each one already done, find it
(`git branch`, `git log`, `gh pr view`, `gh issue view`) and finish or update it. A record with no `Run:` line, or
one naming a different `started_at`, is from an earlier run that has ended: ignore it entirely, and overwrite it.

An attempt can stop after an action succeeds but before it is recorded. So before you create anything, also look
for it in git and on GitHub, not only in the record:

- before making a branch, `git branch --list '<name>'` for the name you are about to use;
- before opening a pull request, `gh pr list --head <branch> --state open`;
- before filing an issue, `gh issue list --state open --search '<the title you are about to use>'`.

If it already exists and matches this setup change, adopt it and record it instead of creating another. Never
create a second branch, commit, issue or pull request for this run.

Record each outward action in `.agent-terminal/loop/artifacts/repo-setup-publish.md` as soon as it completes, with
its name, number or URL, under a first line `Run: <started_at>`. A redo or retry after a partial publish then
resumes where this attempt stopped.

## Decide what changed

Read the setup step's summary (`repo-setup-summary.md`) for the files it changed. Then check git's own view of the
two setup files: `git status --porcelain -- .gitignore loop-capabilities.yaml`. A file counts as changed only when
the summary lists it and git shows it as modified or new, or an earlier attempt of this run's publish step
already committed it on this run's branch, whether that branch is recorded or found by the lookup above.

**When neither file changed:** make no branch, commit, push, issue or pull request. Say in your output that the
repository needed no change, and stop there.

## Publish

1. Read the repository's contribution rules: `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING*`, pull-request templates
   (`.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE/`) and similar. They decide the branch
   name, the commit message, the pull request's title and body, and whether an issue is needed.
2. Find the base branch the pull request will target (the repository's default branch unless its rules say
   otherwise) and run `git fetch origin <base>`. If the fetch fails, or there is no `origin`, make no branch, push,
   issue or pull request: report git's error in your output and stop.
   - Starting fresh (no branch recorded or adopted for this run): run `git log --oneline origin/<base>..HEAD`. If it
     exits non-zero, report git's error and stop, as above. If it lists any commit, the current branch holds work
     of the operator's that is not on the base, and a branch made here would publish it. Make no branch, push,
     issue or pull request. Say in your output why the publish stopped, and that the operator can switch to the
     base branch and redo this step.
   - Resuming this run's branch (recorded, or found by the lookup above): run `git switch <branch>` first, and
     stop and report git's error if it fails. Then run `git log --oneline origin/<base>..<branch>`. It may list
     only this run's setup commit. If it lists anything else, or fails, stop as above.
3. **Issue.** File an issue only when those rules require an issue for every pull request, and then link the pull
   request to it the way the rules say. Otherwise file none, and link the pull request to no issue.
4. Make a new branch from the current commit, named by those rules, and switch to it: `git switch -c <name>`
   (skip this when resuming this run's branch, which you switched to above).
5. Commit **only** the setup change, without touching the operator's index or working tree. The working tree can
   hold uncommitted edits of the operator's, even in `.gitignore`, and the index can hold changes they staged.
   Neither `git add` nor `git commit -- <paths>` can keep those out, so build the commit in a temporary index.
   - When resuming this run's branch and step 2's `git log` already lists its setup commit, skip this step and go
     to step 6. Never add a second setup commit.
   - First confirm `git symbolic-ref --short HEAD` prints this run's branch. If it does not, stop and report.
   - Run everything that uses the temporary index as **one** shell command. A variable exported in one command
     does not reach the next, and a `git read-tree` that runs without it overwrites the operator's real index.
     In that one command, set `GIT_INDEX_FILE=<a temporary path outside the working tree>` with `export`, add
     `trap 'rm -f <that path>' EXIT` so the file goes whether or not the commit succeeds, then:
     - `git read-tree HEAD`;
     - `.gitignore`, when it changed: stage `HEAD`'s `.gitignore` (empty when it is not in `HEAD`) plus the one
       `.agent-terminal/` line. Write that content with `git hash-object -w --stdin` and stage the blob with
       `git update-index --add --cacheinfo 100644,<blob>,.gitignore`;
     - `loop-capabilities.yaml`, when this run created it: `git add -- loop-capabilities.yaml`;
     - `git commit -m "<message>"`.
   - If that command fails, nothing was committed and the operator's index is untouched: report the error and
     stop.
   - `git reset -q -- .gitignore loop-capabilities.yaml`, so the real index agrees with the new commit for those
     two paths. Every other entry the operator had staged stays staged, and their working-tree edits stay as they
     were.
   - Check the result: `git show --stat HEAD` lists exactly the files you staged, no more and no fewer. When
     `.gitignore` changed, `git show HEAD:.gitignore` is `HEAD~1`'s `.gitignore` (empty when `HEAD~1` has none)
     plus the one `.agent-terminal/` line, which appears in it exactly once. If not, stop before pushing and report what the commit holds.
6. Push the branch and open the pull request as a **draft** (`gh pr create --draft`), with the title and body the
   rules ask for.

## Your output

Write `.agent-terminal/loop/artifacts/repo-setup-publish.md` for the operator: whether the repository needed a
change, and, if it did, the branch, the commit, the issue (or that the rules needed none) and the draft pull
request's URL. Approving this step only finishes the run; it does nothing outward.
