# Bench — re-run a span of a flow from a captured fixture

The bench runner re-runs part of a flow (a *span* of its steps) from a point captured in a real run, N times,
one run after another, in this checkout's app. It is a re-run harness for the operator to judge loop behaviour
after changing a prompt, a charter or a model; it scores nothing, and runs are not hermetic: each run works a
real copy of a real GitHub issue, and the operator answers every human gate live in the normal UI.

The app side of the runner-to-app launch contract and the span guard are specified in
[§18.7.8](spec/18-flow-definitions-flow-yaml.md#1878-bench-launch-contract-and-span-guard-180). This doc owns the
fixture format, the run-record format and the run-folder layout.

## Commands

```
pnpm run bench capture <working-folder> <fixture-dir>
pnpm run bench run --flow <catalog-id|path to flow.yaml> --span <first>[..<last>] --fixture <fixture-dir> --runs <n>
```

The `bench` script builds the app first, then runs the runner with this checkout's Electron in plain-Node mode.
Relative paths resolve against the directory `pnpm` was run from (`INIT_CWD`).

- **`capture`** turns the working folder of a real run into a fixture at `<fixture-dir>`, which must not exist
  yet. It is refused, writing no fixture, when git reports a change outside `.agent-terminal/` (a modified or
  staged tracked file, or an untracked file git does not ignore), or when the folder's flow has no resolved
  GitHub-ticket input. "Captured after step X" is the operator's choice of moment: capture once X has finished
  and the flow has moved to its next step, before that step starts.
- **`run`** checks every refusal first, then makes sure the fixture issue's repository has the `bench-run` label
  (creating it, once, when it is missing; an existing label is never changed), then performs N runs. Each run
  gets a fresh git worktree at the fixture's commit on its own branch, the fixture's flow documents and state,
  its own copy of the fixture's issue, and this checkout's app opened at the span's first step, ready to Start.
  The next run is prepared only after the previous run's app has exited and its record is written. The command
  prints each run's folder.

Each refusal, and each failure of the label, a run's preparation or its output, prints a stable code (for example
`fixture-unparsable`, `pr-acting-gate`, `label-failed`) and a sentence naming it, and exits non-zero. Any other
failure, such as running outside a git repository, prints `bench <command> failed:` with its cause and exits
non-zero. The PR-acting-gate check runs twice: once before
anything else, over the invoking repository's loop defs, and again in each run's working folder before its issue
is copied, because the app loads the fixture commit's own repository-tier loop overrides there. A hit in the
working folder stops the command with `pr-acting-gate` and keeps that run's folder.

## Fixture format

A fixture is a folder holding `fixture.json` and an `artifacts/` folder. `artifacts/` mirrors the captured
folder's `.agent-terminal/loop/artifacts/`, subfolders included, and is restored into each run's working folder
byte for byte. A fixture may be written by hand.

```json
{
  "schema_version": 1,
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "phase_baseline": "89abcdef0123456789abcdef0123456789abcdef",
  "issue": {
    "repository": "github.com/owner/repo",
    "number": 180
  },
  "inputs": {
    "slices": "2"
  },
  "repeat_counts": {
    "refactor": 1
  }
}
```

- `commit` — the full object id of the commit checked out in the captured folder. It must exist in the
  repository the runner is run from.
- `phase_baseline` — optional: the phase baseline commit (§28.5.1) recorded for the captured folder's branch.
  Each run records it for its own branch.
- `issue` — the GitHub issue the captured run works. `repository` is the `host/owner/name` selector; it is read
  without regard to case and written lower-case, and must be the invoking repository's GitHub repository.
- `inputs` — the flow input values resolved so far, as strings. It never holds the flow's ticket input: each
  run's ticket input is its own issue copy.
- `repeat_counts` — each repeat step's position in its loop (§28.4.1), as a whole number of at least 1.

Any other key, or a value of the wrong kind, makes the fixture unparsable.

## Each run's issue copy

Each run creates a new issue in the fixture issue's repository, copying the fixture's issue as it stands then:
its title and body verbatim; every label except `agent-loop/ready`, plus `bench-run`; and each comment in order,
posted as one comment whose first line names the original author's login (without an `@`, so it notifies no
one) and time, followed by the original text verbatim. Because the body and comments are reposted verbatim, any
`@` mention or issue reference inside them notifies or backlinks again on every run. The runner never writes to
the fixture's issue and never closes a copy; the `bench-run` label is how to find copies to clean up.

## Run folders

Every command makes one folder `<app home>/.agent-terminal/bench/<stamp>/`, and each run k a folder `run-<k>/`
inside it, never reused:

- `bench-<stamp>-run-<k>/` — the run's working folder, a git worktree on branch `bench/<stamp>/run-<k>`, holding
  every flow document the run produced. A span that includes the flow's pickup step then works on pickup's own
  branch for the run's issue copy, based on the base branch as it stands at that moment.
- `audit/` — a copy of the run's §25 audit log. A span that ended before Start has none.
- `span-end.json` — written by the app when the span ends (§18.7.8).
- `run-record.json` — the run record.

A run whose preparation fails stops the command with its code, naming the folder it kept; earlier runs keep
their records.

## Run-record format

```json
{
  "schema_version": 1,
  "flow": {
    "id": "feature-dev-v3",
    "definitionRevision": "3f1c0b7e9a2d4c6f8e0a1b3c5d7e9f1a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e"
  },
  "promptRevision": "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d",
  "fixture": "/home/operator/fixtures/gate-probe",
  "span": {
    "first": "plan",
    "last": "plan"
  },
  "fixtureIssue": {
    "repository": "github.com/owner/repo",
    "number": 137
  },
  "issueCopy": {
    "number": 412
  },
  "branch": "bench/20261020T120000.000Z/run-1",
  "ending": "left span",
  "wallClockMs": 754000
}
```

- `flow.id` — the flow definition's `name`, whether the flow was named by catalog id or by path.
- `flow.definitionRevision` — changes when, and only when, the bytes of the `flow.yaml` the run loaded change.
- `promptRevision` — changes when, and only when, the bytes of any loop-definition file, brief, recipe or
  charter that the span's loop steps resolve to change, from whichever loop-definition tier the app resolves
  them from.
- `fixture` — the absolute path of the fixture the runner read.
- `ending` — how the span ended: `left span` (the flow would have moved to a step outside the span, and did
  not), `completed`, `terminated`, `window closed` (the operator closed the app's window), or `app exited` (the
  app exited for any other reason, such as its shell exiting, the operator quitting it, or a crash, before the span ended),
  or `app did not start` (the app could not be started at all; the command then stops with `app-did-not-start`
  and its cause, and prepares no further run).
- `wallClockMs` — from the runner starting the run's app to that app having exited, so it includes the app's
  start-up and its quit; preparing the run and writing its record are excluded.

**Versioning.** `schema_version` is an integer. A field added without breaking a reader keeps the version, and
readers ignore keys they do not know; only a breaking change bumps it, and a reader refuses a version it does
not know.

## Carried inputs

A `pr`-typed flow input in the fixture is carried unchanged; it names the captured run's pull request, not one of
the run's own.

## How a prompt edit reaches a run

A run loads, and the prompt revision hashes, the copy of each loop file the app resolves for that step. Once a
loop definition has been copied to the operator tier under `~/.claude` (by its first use, or by Install
examples), that copy wins over the shipped one. So either edit the operator-tier copy, or edit the shipped file
under `example/loops-v2/`, then rebuild (the `bench` script builds) and run Install examples from this build to
refresh the operator copy and the installed reviewer sub-agents.
