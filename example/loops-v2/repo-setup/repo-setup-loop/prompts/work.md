# repo-setup — set the repository up for agent loops

You are setting this repository up so Agent Terminal's loops work well in it. Two things may need fixing, and
you fix only the ones that need it:

1. **Git must ignore the whole `.agent-terminal/` folder.** The app keeps its flow documents there, and they must
   never show up in `git status`, commits or checks that read untracked files.
2. **The repository needs a `loop-capabilities.yaml`** at its root that describes its real test files and its
   real test and build commands.

## Judge against the repository as it stood before this run

Decide what needs fixing from the repository as it was before this run began, never from changes this run has
already made.

- This run is identified by the `started_at` value in `.agent-terminal/flow-state.yaml`. Read it first.
- If `.agent-terminal/loop/artifacts/repo-setup-summary.md` exists and its `Run:` line names that same
  `started_at`, an earlier attempt of this run wrote it (a redo or a retry). Each file it lists as created or
  changed is this run's own work: you may revise it, and its current state is not evidence that the repository was
  already set up. Carry that list forward into the summary you write now.
- A summary with no `Run:` line, or one naming a different `started_at`, is from an earlier run that has ended.
  Ignore it entirely, and overwrite it. What that run changed is now the repository's own.
- Any other existing state of `.gitignore` and `loop-capabilities.yaml` is the repository's own.

## Stop first if the operator has work in progress here

The next step commits the setup change from the operator's live working tree, so their own work there must not be
mixed in with it.

**The setup `.gitignore`** is `HEAD`'s `.gitignore` content (empty when `HEAD` has none), plus a newline if that
content is non-empty and does not end in one, plus the line `.agent-terminal/` and a newline. So when `HEAD` has
no `.gitignore`, it is exactly the one line `.agent-terminal/`. Decide first whether each file exists:
`git cat-file -e HEAD:.gitignore` for `HEAD`'s, `test -e .gitignore` for the working tree's. Both absent counts as
matching `HEAD`. Compare contents (`git show HEAD:.gitignore` and `cmp`) only when both exist. Never compare with
`git diff`, which shows nothing for an untracked file.

Before you change anything, check:

- `git diff --cached --quiet` exits 0: nothing is staged.
- `.gitignore` holds no uncommitted edit of the operator's. Either it matches `HEAD` (absent when `HEAD` has none,
  and otherwise the same content), or this run's earlier summary lists `.gitignore` as changed and the file is
  exactly the setup `.gitignore`.

If either check fails, change no file. Write the summary with **Stopped** as its second line. Still carry forward
the **Files changed** list from this run's earlier summary, if there is one. Say what you found, and that the
operator can commit, stash or unstage that work and then redo this step.

## What to do

**The ignore rule.** Ask git itself: `git check-ignore -q -- .agent-terminal/` exits 0 when the whole folder is
already ignored (through `.gitignore`, `.git/info/exclude` or the user's global excludes).

- Exit 0, already ignored through any source, including the user's global excludes: leave `.gitignore` exactly as
  it is, unless this run's own earlier summary lists `.gitignore` as changed (then it is this run's work). Do not
  touch it otherwise.
- Any exit other than 0 or 1 means git could not answer (for example 128: not a repository, a `safe.directory`
  refusal or a broken config). Leave `.gitignore` untouched, report git's error under this item in the summary,
  and go on to the next item.
- Exit 1, not ignored: make the `.gitignore` at the repository root exactly the setup `.gitignore` above, creating
  the file if there is none. That adds the one line `.agent-terminal/` and changes nothing else. Run the `git check-ignore` command again and confirm it exits 0. A rule
  that ignores only some paths under `.agent-terminal/` does not count.

**`loop-capabilities.yaml`.**

- If the repository already has a `loop-capabilities.yaml` of its own, leave it exactly as it is, even if it looks
  wrong or the check below would reject it. Do not edit, replace, move or delete it.
- If there is none, write one at the repository root. Find the real test files and the real commands in the
  repository: its package manifest or build files, its CI workflow and its contributor docs. Use globs that match
  the test files that exist, and the commands a contributor actually runs. Never invent a command. Then run the
  self-check below and fix the file until it passes.

**Outward actions.** Commit nothing, push nothing, create no branch, and file no issue or pull request. Those
happen only in the next step, after the operator approves this one. Do not stage anything either.

## The summary

Write `.agent-terminal/loop/artifacts/repo-setup-summary.md` for the operator, who approves or redoes this step from
it. Its first line is `Run: <started_at>`, with this run's `started_at` value. Then, in plain words:

- **Files changed** — a list of exactly the files this run created or changed (`.gitignore`,
  `loop-capabilities.yaml`, or neither), including any carried forward from an earlier summary. Write `None.` when
  neither changed. The next step commits only the files on this list.
- For each of the two items: what you found before this run, what you did, and why.
- For a new `loop-capabilities.yaml`: which test files its globs match, and where each command came from.
- If an existing `loop-capabilities.yaml` was left alone: say so, and say whether the self-check accepts it, so the
  operator knows the app may still report it.
