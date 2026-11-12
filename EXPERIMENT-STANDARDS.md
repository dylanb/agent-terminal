# EXPERIMENT-STANDARDS.md

How to work a ticket that changes how fast a factory run goes or how many tokens it uses. Try the change on a control ticket, in a run that cannot see any other run, and log the results on the experiment ticket before deciding to keep it.

This is a guide, not a rulebook. Deviate from it wherever something else makes more sense for your situation, and say what you changed in the results.

## Control ticket

Every experiment names 1 control ticket and 1 base commit, and every run starts from both.

- **The ticket text.** Use the original text of an existing issue, taken from its edit history, because the groom step rewrites the body.
- **A new issue per run.** Each run gets its own issue holding that text verbatim. A link back to the original or to an earlier run invites the agent to go and read it.
- **The base commit.** Pickup branches the run from origin's base branch (§27), so checking out an older commit does not pin a run. Start the baseline and the trial from the same commit of `main` and record it. If `main` moved between them, list the commits in between.
- **The baseline.** A run of the same flow without the change, or an earlier run whose tokens were counted the same way.

## Isolation

A run must not be able to read another run's work. Telling it not to look is not enough, since an earlier run told to work blind read the original issue and its branches.

- **A fresh clone** with `--single-branch --branch main --no-tags`, outside any folder that holds another clone or worktree.
- **Its own `CLAUDE_CONFIG_DIR`.** Session logs live under it. Run **Install examples** from the build under test with it set, and give the baseline and the trial the same user `CLAUDE.md`. Claude Code reviewer agents are installed by the run itself, in the clone's `.claude/agents` when the flow starts, so start `claude` in the clone after pressing Start.
- **Its own `APP_HOME_DIR`.** Audit records go to `<app home>/.agent-terminal/audit/<clone folder name>/` (§25.2), so with the default home every run shares 1 audit tree.
- **A guard hook.** A `PreToolUse` hook in the clone's `.claude/settings.local.json` that denies any tool call naming another run's issue, branch, clone, config directory or audit tree. It fires for sub-agents too.
- **A check afterward.** The hook cannot see inside a script an agent writes, so search the run's session logs for what the hook guards. A hit means the results do not count.

Start the app from a plain terminal. A `claude` started from inside another Claude Code session saves no session log. Before starting the flow, confirm the run is using the change, because a loop definition in the operator's config directory takes precedence over the bundled one.

## What to log

Count tokens from the session logs, split into uncached input, cache write, cache read and output, under the step whose session made each call. Report tokens, never dollars alone. For experiments targeting run speed, also report elapsed time per step and slice for the baseline and trial, with human-gate waiting reported separately.

Log these quality signals for each run.

- Whether the tests pass at the end of each step that runs them.
- Review passes per step.
- Findings per pass by severity, and how many were dismissed as invalid.
- Gate pushbacks, meaning each change asked for at a human gate.
- Late findings, meaning a blocker or major raised later in an area an earlier reviewer covered.

Post the results in these 2 tables as 1 comment on the experiment ticket, with 1 row per run for each step and slice.

| Step | Slice | Run | Uncached input | Cache write | Cache read | Output | Total |
|---|---|---|---|---|---|---|---|

| Step | Run | Tests passing | Review passes | Findings by severity | Dismissed | Gate pushbacks | Late findings |
|---|---|---|---|---|---|---|---|

Under the tables, give each run's issue, base commit and build. End with the call and the reason for it.

## The call

The developer decides whether to keep the change, drop it or run again. There is no threshold and no required number of runs.

Runs of the same flow vary. In the run that tested the first savings, a smaller groomed ticket and a short review cut tokens apart from the changes. Weigh that when deciding whether the evidence is clear enough.

A change that cut tokens and lost findings is recorded as such, with the findings it lost.
