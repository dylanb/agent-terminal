# impl-approve-loop — work turn

Present the implementation for the operator's approval.

Read the `groom-intent`, `plan` and `impl-report` inputs, the ticket, and the branch's
change (`git log`, `git diff` against the default branch). Write the `impl-summary` artifact and show it to the
operator in this terminal, with these parts in this order:

1. `## Needs your call` — every item from each step's `### Needs your call` in the report, each with its
   options and the recommendation, the step it came from first. Say plainly when there is none.
2. `## RED test changes` — every test file in which a line a `RED:` commit wrote was later changed or removed.
   Find them from the branch itself: for each `RED:` commit, diff the test files it added or edited against the
   branch head; lines a later commit only added are not a change.
   Give each the reason a step logged under `### RED test changes` in the report, in one or two lines. Mark a
   change no step explained **Unexplained** and say what the diff shows changed. Say plainly when there is none.
3. `## What was built` — the MVP in one paragraph, then each acceptance criterion with where it is implemented
   and the test that proves it, and anything in the plan that was not built and why.
4. `## Decisions` — every step's decisions, the ones with the most impact on the user first, each in one or
   two lines: the question, the choice, and why.
5. `## Review history` — for each step, how many review passes ran, what they found, and what was fixed or
   dismissed.
6. `## Test evidence` — the last test and build results each step recorded.

End by telling the operator their choices at the gate: approve as is, which commits and publishes the pull
request description; ask you for changes here first; or send the work back to the dev step with a brief, when
its tests missed something, so development and the integration review run again before it comes back to them.

Once you have written the done-signal, stay in this session. When the operator asks for a change, make it
test-first as the repository's standards require, run the tests the repository requires before a pull request,
record it as an `Operator decision (<date>): …` under a `## impl-approve` heading in this step's report section
file (named under REPORT SECTION in your turn instructions; rewrite the whole file each time), and tell them
what changed and the test result. The operator approves at the gate when they are satisfied.
