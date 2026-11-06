## 29. Repository setup check and the repo-setup flow

Nothing else tells the operator that a repository is not ready for agent loops: loops run on stale installed
examples, the app's flow documents under `.agent-terminal/` show up in `git status` and commits, and without a
`loop-capabilities.yaml` the RED/GREEN gates are weaker (§28.5.6). The setup check finds these conditions and a
blocking popup offers the fix: install or update the examples, or run the bundled `repo-setup` flow, which makes
the repository changes behind a human gate.

The app itself never edits `.gitignore`, never creates `loop-capabilities.yaml` and never commits (§19.1). Only the
`repo-setup` flow's agent changes the repository, and only after the operator has started the flow and approved
its first gate.

### 29.1 When the check runs

- At app start, for the directory the terminal starts in, and the first time in an app session that the terminal
  enters a git repository it has not checked yet (a change of the terminal's repository key, §16.3). A repository is checked at most once per
  session, keyed by its repository key (§16.3), so each worktree is checked, and dismissed, on its own.
- After startup, entering a directory that is not a git repository raises no popup, even while the examples
  condition fails. The startup check, outside a repository, shows the examples condition alone.
- Checks run one at a time, in the order the terminal entered the repositories. A popup due while another app
  dialog is open waits until that dialog closes, so two modal dialogs are never open together (UI-STANDARDS.md §5).
- A check that could not run (the status request fails or is rejected) shows nothing and does not count as done:
  the next entry into that repository in the session checks it again. A check that could not run never passes.
- `APP_SETUP_CHECK=off` turns the check off: the status reply then lists nothing. It is a test seam with no UI,
  set by default on every e2e launch (`docs/e2e-podman.md`). Unset, or any other value, means the check runs.

### 29.2 The three conditions

Each failing condition is one entry with a failure kind, `SetupConditionEntry` in `src/shared/setupCheck.ts`. The
popup gives each failure kind its own plain-words message.

1. **Examples** (`examples`) — machine-level, evaluated in every check. It fails (`stale`) when Install examples
   (§18.1) would create or replace at least one file, or would remove at least one retired example. The verdict
   comes from the installer's own inspection pipeline and per-file verdict (`inspectExamplesCurrency` and
   `installFileVerdict` in `src/main/installExamples.ts`), the same ones the install preview reads, so the warning
   and the consent flow cannot disagree. A destination whose tool is absent (no Codex home) counts for nothing. A
   file the operator edited on purpose counts as "would be replaced". When the inspection cannot run, the entry is
   `unchecked`. Completing the consent flow while declining any change leaves the condition failing; the
   per-version dismissal (§29.4) is the way out.
2. **Ignore** (`ignore`) — git ignores the **whole** `.agent-terminal/` folder through any source git consults: the
   repository's `.gitignore` files, `.git/info/exclude`, `core.excludesFile` and the default user-global excludes
   file. The answer is git's own `check-ignore` verdict for the folder, whether or not it exists on disk
   (`src/main/gitIgnoreCheck.ts`). It runs with the repository's git hardening (`src/main/gitHardening.ts`), so a
   repository-planted `core.fsmonitor` or hook cannot run, and its path travels as an argv element. Ignoring only a
   path beneath the folder fails (`not-ignored`): a repository that commits shared flows under `.agent-terminal/`
   fails by design, and its way out is the per-repo dismissal. When git exits with an error, cannot be spawned or
   times out, the entry is `unchecked`.
3. **Capabilities** (`capabilities`) — the repository has a `loop-capabilities.yaml` the app's reader accepts
   (`loadLoopCapabilities`, §28.5.4). The failure kind is the reader's own `cause`: `absent`, `malformed` (also a
   path that is not a regular file) or `confinement` (a symlinked or unresolvable file).

Conditions 2 and 3 are evaluated only inside a git repository: one whose repository key is its own root
(`findRepoRoot` in `src/main/repoKey.ts`, which `resolveRepoKey` is built on). A `.git` file, as in a worktree or a
submodule, counts as a root.

### 29.3 The popup

A blocking modal dialog (UI-STANDARDS.md §5, every press through §1.4), raised only when the status lists at least
one entry. Inside a repository it names the repository it was raised for, since the terminal may `cd` away while it
is open, and every action acts on that repository. It lists each failing, undismissed entry and offers only the
controls that apply:

| Control | Shown when | What it does |
|---|---|---|
| **Install/update examples** | an `examples` entry is listed | Closes the popup and opens the Settings view's existing install-examples flow, unchanged |
| **Run setup loop** | the shipped `repo-setup` flow is installed (below) and an `ignore`/`not-ignored` or a `capabilities`/`absent` entry is listed | §29.5 |
| **Don't show again for this repo** | an `ignore` or `capabilities` entry is listed | §29.4 |
| **Don't show again until the app updates** | an `examples` entry is listed | §29.4 |
| **Close** | always | Closes the popup and records nothing; Escape and the scrim do the same |

- Closing the popup through Install/update examples also closes its repository entries for the session; they return
  at the next start unless fixed or dismissed.
- Run setup loop is not offered for `malformed`, `confinement` or `unchecked` entries alone: the flow leaves an
  existing `loop-capabilities.yaml` untouched and cannot fix git.
- **Installed** means the `repo-setup` catalog entry resolves to the global tier, so the repository has no
  `repo-setup` entry of its own (`src/main/setupFlowInstalled.ts`). A repository entry would outrank the shipped
  one at Start (§18.1), so the button is never offered for a flow the repository supplies. The operator can still
  pick that flow in the picker.

### 29.4 Dismissal

- **Don't show again for this repo** silences the `ignore` and `capabilities` entries for that repository key across
  restarts. It does not silence another worktree or the main checkout.
- **Don't show again until the app updates** silences the `examples` entry until the app's version
  (`app.getVersion()`) changes.
- Which entries a dismissal silences has one definition, `silencedBy` in `src/shared/setupCheck.ts`: main filters
  the status with it and the popup removes entries with it. After a dismissal the popup stays open while anything
  is listed, with focus on a remaining control; it closes when nothing is left.
- Both are recorded in one app-owned file, `<A>/.agent-terminal/setup-dismissals.json` under the app-state home
  (§23.4), outside every repository and disjoint from every other app-written file
  (`src/main/setupDismissals.ts`). A missing, oversized, malformed or schema-invalid file reads as no dismissals, so
  the warning still shows. A failed write is shown inside the popup, which keeps its entries so the operator can
  retry or close. Recording a dismissal never touches the repository.
- A repository dismissal is accepted only for a repository key the app has entered (§6). A dismissal made in one
  instance applies to another at its next check; two made at the same instant can lose one, whose warning simply
  shows again.

### 29.5 Run setup loop

Run setup loop selects `repo-setup` for the popup's repository and starts it through the two requests the picker
and the flow strip already make, `flow:setActiveFlow` then `flow:start` (§18.7). It adds no Start path in main or
the renderer: the start runs through the flow strip's own Start handling, so what follows is exactly what a Start
press does. The flow declares no inputs, so no ticket prompt opens.

- When the repository's run has begun (in progress, or done and not reset, §18.7), the selection gate refuses it.
  The popup closes and an alert says the run must be ended (Terminate) first. The progression, the selected flow and
  the run's files are unchanged.
- Otherwise the popup closes and the flow starts. A start that then fails shows as any failed Start press does.
- The selection stays on `repo-setup` after the run finishes; the operator returns to their own flow through the
  §18.7 rules.

### 29.6 The repo-setup flow

`example/flows/repo-setup/` with its loops under `example/loops-v2/repo-setup/`, shipped in the bundle and installed
by Install examples. Two `loop` steps, both `gate_authority: human`, no reviewers, no `inputs` and no `bootstrap`:
the app's pickup (§27.10) is not used.

1. **`setup`** (`repo-setup-loop`). One work turn. The agent adds a whole-folder `.agent-terminal/` rule to
   `.gitignore` only when git does not already ignore it, and writes `loop-capabilities.yaml` from the repository's
   real test files and commands only when none exists, leaving an existing one untouched. It commits, pushes and
   files nothing. Its LoopDef declares `work.self_check: loop-capabilities` (§27.8), so the work prompt carries the
   reader's canonical example (`exampleLoopCapabilities`) and the command that runs the app's own reader over the
   file (artifactCheck's `capabilities` mode); the agent runs it until it passes. The check is prompt-only: the
   engine does not gate the turn on it, and the human gate is the backstop. On redo, the agent judges against the
   repository as it stood before the run, through its earlier summary.
2. **`publish`** (`repo-setup-publish-loop`). Runs only after the operator approves `setup`. The agent decides from
   git's own view whether either file changed; if neither did, it makes no branch, commit, issue or PR. Otherwise it
   follows the target repository's own contribution rules (its `CLAUDE.md`, `CONTRIBUTING`, PR template and
   similar) for the branch, commit message and PR body, commits only the two setup files, and opens a **draft** PR.
   It files an issue and links it only when those rules require one for every PR. On redo it resumes the branch,
   issue or PR this run already made, never a second one. Approving this step's gate only completes the run.

Exactly one operator approval comes before any commit, push, issue or PR. A run with no pickup is not held to a
branch (§27), so the branch the publish step creates does not block it.
