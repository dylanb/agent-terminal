# simple-dev-loop-v1 — work turn

Build every increment of the approved plan test-first, per `CLAUDE.md`, then clean up, then review until clean.

Read the `plan` and `groom-intent` inputs, the ticket, and the repository's agent instructions for the commands it
runs its tests and build with and the environment each test type must run in. When this step runs again after a
later gate sent the work back here, read the `impl-report` input's sections and the branch's `RED:` and `GREEN:`
commits first: keep the increments already done, and redo only what the later step or the operator found wrong.
When the operator wrote a brief with that decision, your instructions carry it: it is what they want redone.

## The team

You keep this session's context for judgement: what to build, whether it is right, and what to commit. The
writing is done by sub-agents, so the code and test files they read never fill your context.

- Start every sub-agent with your agent tool, with the model set to Sonnet (`model: sonnet` in Claude Code). Use a
  fresh sub-agent for each RED and for each GREEN; never continue one from an earlier increment.
- Its brief is the only context it has: the increment's acceptance criteria and the plan's test plan and
  technical plan for it, the files to read first, the repository's testing and code standards by path, and the
  rules this step's brief gives for its phase. Tell it to report the files it changed and the test command it ran
  with its result, and not to commit.
- Never take a sub-agent's word for a result. Run the tests and the build yourself before every commit. Of the
  end-to-end tests, run only the increment's and those that cover the files it changed, counting a test that uses a
  changed harness, fixture or fake as covering it. The full end-to-end suite runs at the integration-slice step and at
  finalization.
- When your agent tool cannot choose a model, use its default model and record that under `### Decisions`.
  When you have no agent tool, write the tests and code yourself, and record that the same way.

## For each increment, in the plan's order

1. **RED.** Brief a sub-agent to write the failing tests for the increment, and to make the plan's edits to or
   deletions of existing tests for it, asserting observable behavior and never the implementation, under the
   brief's **A RED must fail at its own check**. It must not touch production code.
2. **Check the RED.** Run the increment's new and edited tests, each in the environment the repository's
   conventions prescribe for its type, and every other test the repository requires before a pull request, except
   the full end-to-end suite: of the other end-to-end tests, run only those that cover the files the increment
   changed. Valid only when every new or edited test fails by an assertion at the check it exists for, or all pass
   for a verification-only increment shown failing in a scratch copy, and every other test that ran passes. A
   compile, import or collection error, a test that fails before its own check, or no test selected is not a RED:
   send the sub-agent's work back with what is wrong, or fix it yourself, and check again.
   Ask the brief's two questions of each test before you go on.
3. **Commit the RED** as `RED: <increment title>`, holding only the test changes, following the repository's
   commit conventions. Record the failing run under `### Increments`. A verification-only increment has no
   production change to make: it ends here, with no `GREEN:` commit, and you go on to the next increment.
4. **GREEN.** Brief a fresh sub-agent to make the smallest change that makes the increment's tests pass, under
   the brief's **Make it work, then make it readable**. It changes a line of a committed RED test only when that
   test is wrong, and reports each such change with why. Any test it adds for a branch or failure path its design
   introduces it writes and runs failing first.
5. **Check the GREEN.** Run the tests and the build the repository requires before a pull request, except the full
   end-to-end suite: of the end-to-end tests, run only this increment's and those that cover the files it changed.
   Valid only when they pass. Read the diff yourself: send back, or fix, anything that is not the smallest change,
   changes a RED test without reason, or breaks a repository standard.
6. **Commit the GREEN** as `GREEN: <increment title>`. Log every RED test line it changed under
   `### RED test changes`.

## Clean up

When every increment is committed, diff the branch against its base. Every changed file must trace back to the
ticket's scope: revert anything else — a refactor that crept in, an unrelated tidy-up, a file touched by
accident — and log it under `### Scope reduction`. Then make what the change introduces readable, as the brief
says, and run the tests and the build again, with the end-to-end tests limited to those that cover the files the
clean-up changed. Commit any change this makes, following the repository's commit conventions.

## Review until clean

1. Do the work above.
2. Run the tests and the build the repository requires before a pull request, except the full end-to-end suite: of the
   end-to-end tests, run only those for this step's increments and those that cover the files this step changed,
   counting a test that uses a changed harness, fixture or fake as covering it. The full end-to-end suite runs at the
   integration-slice step and at finalization. Confirm they pass. Record the commands and their results, and which
   end-to-end tests you chose for which changed files (or why none covers a change), under `### Test evidence` before
   any review, so every reviewer reads results that match the change.
3. Review it with the reviewers below, as the review rules in these instructions say. Give the red-authenticity
   reviewer the `RED:` commits: it checks each one out and sees its tests fail there.
4. Fix or dismiss every finding, and log each in the report. A fix may use a fresh Sonnet sub-agent like any
   other change, and a fix to behavior starts with a failing test. When a fix changes code or tests, run the tests
   again, commit it, and update `### Test evidence` before the next pass.
5. Repeat steps 3 and 4 until the review ends, as the review rules in these instructions say.
