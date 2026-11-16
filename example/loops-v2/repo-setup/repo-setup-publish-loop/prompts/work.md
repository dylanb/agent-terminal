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

## Stop if the operator has work in progress here

If the setup step's summary (`repo-setup-summary.md`) has **Stopped** as its second line, make no branch, commit,
push, issue or pull request. In your output, say that the setup step stopped and why. Say that the operator can
commit, stash or unstage that work, then Terminate this run and start repo-setup again.

**The setup `.gitignore`** is `HEAD`'s `.gitignore` content (empty when `HEAD` has none), plus a newline if that
content is non-empty and does not end in one, plus the line `.agent-terminal/` and a newline. So when `HEAD` has
no `.gitignore`, it is exactly the one line `.agent-terminal/`. Decide first whether each file exists:
`git cat-file -e HEAD:.gitignore` for `HEAD`'s, `test -e .gitignore` for the working tree's. Both absent counts as
matching `HEAD`. Compare contents (`git show HEAD:.gitignore` and `cmp`) only when both exist. Never compare with
`git diff`, which shows nothing for an untracked file.

Otherwise check again, because the operator may have changed things while they reviewed the setup step:

- `git diff --cached --quiet` exits 0: nothing is staged.
- `.gitignore` holds no uncommitted edit of the operator's. It matches `HEAD` (absent when `HEAD` has none, and
  otherwise the same content), or it is exactly the setup `.gitignore`.

If either check fails, make no branch, commit, push, issue or pull request. Say in your output what you found, and
that the operator can commit, stash or unstage that work and then redo this step. This keeps the operator's own
work out of the setup commit.

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
5. Commit **only** the setup change.
   - When resuming this run's branch and step 2's `git log` already lists its setup commit, skip this step and go
     to step 6. Never add a second setup commit.
   - Confirm `git symbolic-ref --short HEAD` prints this run's branch. If it does not, stop and report.
   - `git add --` each changed file, then `git commit -m "<message>"`. The check above means nothing else is
     staged.
   - If `git add` or `git commit` fails, run `git reset -q --` on the changed files. The check above proved
     nothing was staged before, so this puts the index back exactly. Then report git's error and stop.
6. Check the setup commit before pushing, on every path, including when step 5 was skipped. The setup commit is
   the tip of this run's branch. Check that `git show --stat HEAD` lists exactly the changed files, no more and no
   fewer. When `.gitignore` changed, `git show HEAD:.gitignore` must be exactly `HEAD~1`'s `.gitignore` (empty when
   `HEAD~1` has none, decided with `git cat-file -e HEAD~1:.gitignore`), plus a newline if that content is non-empty
   and does not end in one, plus `.agent-terminal/` and a newline. If either
   check fails, push nothing and open no pull request: report what the commit holds and stop.
7. Push the branch and open the pull request as a **draft** (`gh pr create --draft`), with the title and body the
   rules ask for.

## Your output

Write `.agent-terminal/loop/artifacts/repo-setup-publish.md` for the operator: whether the repository needed a
change, and, if it did, the branch, the commit, the issue (or that the rules needed none) and the draft pull
request's URL. Approving this step only finishes the run; it does nothing outward.
