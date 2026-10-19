---
name: agent-terminal-loops
description: Run an agent-terminal loop (groom, plan, red, green, refactor, integration-slice, …) by hand in Codex — its work step, its reviewer round, and the judgement of that round. Use when asked to run a loop's reviewers or review personas, to "run the integration-slice reviewers", to review work the way an agent-terminal loop would, or to find where the agent-terminal loop definitions and charters live.
---

# agent-terminal loops

agent-terminal's **Install examples** action put everything this skill uses in your Codex home, written
`<codex home>` below: `$CODEX_HOME` when that is set, else `~/.codex`. Use these installed files. Do not go
looking for loop definitions or charters anywhere else, such as the Claude config directory, and do not
rebuild them from memory.

## Where things are

- **Loop definitions:** `<codex home>/loops-v2/<flow>/<loop>/<loop>.yaml`, for example
  `loops-v2/feature-dev-v2/integration-slice-loop/integration-slice-loop.yaml`. A definition names its own
  files, as paths relative to its directory: its work recipe in `work.recipe`, its judging recipe in
  `consolidator.recipe` when it has review rounds, its standing instructions in `brief` when it has them, and
  each reviewer's charter in `reviewers[].charter`. A definition with a `work.goal` reviews its own work.
- **Reviewer agents:** one custom agent per reviewer, in `<codex home>/agents/`. Its name is the loop
  name and the persona name joined by `__`, with every `-` written as `_`. The `impl-review-reliability`
  reviewer of `integration-slice-loop`, for example, is `integration_slice_loop__impl_review_reliability`.
  Its instructions already are its charter.

If a loop, a charter, or a reviewer agent you need is missing, stop and tell the user to run **Install
examples** in agent-terminal again and then restart Codex, because Codex loads agents only when a session
starts. Do not stand in for a missing piece with something else.

## Running a loop

1. **Read the definition.** Open the loop's `<loop>.yaml`. Its `reviewers:` list is the round's roster,
   one entry per `persona`.
2. **Work.** If the definition has a brief, follow it for the whole loop, including every fix in step 3.
   Then do what its work recipe asks. A definition with no `consolidator` has no review rounds: the loop
   ends here. One with a `work.goal` runs step 3 itself, as its recipe says, and ends once the goal holds. It runs no review
   when its work changed nothing but its own report and recorded test evidence, and stops reviewing after a pass
   whose fixes changed nothing else (an edit to the plan, the ticket, code or tests is a change).
   A recipe that says its section file is named under REPORT SECTION in your turn instructions means a
   binding with a `sections_dir`: a hand run has no turn instructions, so the file is `<sections_dir>/<step>.md`
   for slice 1 and `<sections_dir>/<step>.slice-<n>.md` for a later slice, where `<step>` is the flow step's
   id — for example `impl-report/red.md` and `impl-report/red.slice-2.md`. Rewrite it whole each time. Then
   rebuild the bound document from every section file in that folder, by slice and then in flow-step order,
   with any `_earlier.md` first, because no engine assembles it for you.
3. **Review and fix.** Spawn every reviewer on the roster in parallel as its installed agent, by its exact
   name. Never spawn a default or general agent in place of a reviewer's own. Give every reviewer the
   hand-off below word for word, with your values in place of the `<…>` placeholders, so what it receives
   never depends on how you phrase it. Add nothing to it.

   Open with the issue the work is for:

   ```text
   Review the work for GitHub issue #<n>. Read the issue and its comments with `gh issue view <n> --comments`.
   ```

   or, when there is no issue:

   ```text
   Review this loop's work.
   ```

   Then say what it grades. When the loop changed code:

   ```text
   The code and tests under review are this branch's change: its commits since it left the repository's
   default branch, plus any uncommitted changes. See them with git: `git log`, `git status`, and `git diff HEAD`.
   ```

   or, when the loop produced a file, name that file:

   ```text
   Grade <artifact>, the artifact this loop produced, not the issue body on GitHub. The issue is the
   intent the artifact must honour, and it can still hold text the artifact has since fixed.
   ```

   When you run the loop for one impl-slice of the plan:

   ```text
   This round covers impl-slice <slice> of the plan only; work that belongs to another slice is not under review.
   ```

   When the step carried input documents, one line for each:

   ```text
   Grade it against these documents, beside the ticket:
     - <input-id>: <input-path>
   ```

   Always end with:

   ```text
   FLOW DOCUMENTS — this work's flow documents (the groomed ticket, the plan, the RED/GREEN phase results) live
   only under `.agent-terminal/loop/artifacts/`.
   A file of that kind found elsewhere in the repository is not one of this work's flow documents, so never read
   it as one; it is still work when the ticket names it as something to change.
   The repository's standards and configuration are read where they live.
   Do not run the full test suite or the end-to-end harness: read the test results the work recorded, and run only
   the targeted tests that checking a specific finding needs.
   Do not change any file: report your findings, and the fixer makes every change.
   Return each finding with its file:line, the issue, its concrete consequence, and the fix. Do not rate severity.
   If you find nothing, return exactly: no findings
   ```

   Do not hand it a charter, a diff, a prior review, or other reviewers' findings: it pulls what it needs
   with its tools. Take every finding into your own context, then fix it or dismiss it with a reason. A
   finding only the user can settle is "needs a human".
4. **Judge the round.** Follow the definition's judging recipe. It decides between clean, another round with a
   smaller roster, and stopping for a human. For another round, go back to step 3 with the roster it chose.

## Saying how you know

When asked how you found a file, chose a roster, or decided something, say only what you can check: this
skill, a file you read, or a command you ran. If the reason has since been lost from your context, say so.
Do not reconstruct a plausible account.
