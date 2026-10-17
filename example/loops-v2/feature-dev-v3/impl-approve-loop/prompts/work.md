# impl-approve-loop — work turn

Present the implementation for the operator's approval.

Read the `groom-intent`, `plan`, `impl-report` and `infra-capabilities` inputs, the ticket, and the branch's
change (`git log`, `git diff` against the default branch). Write the `impl-summary` artifact and show it to the
operator in this terminal, with these parts in this order:

1. `## Needs your call` — every item from each step's `### Needs your call` in the report, each with its
   options and the recommendation, the step it came from first. Say plainly when there is none.
2. `## What was built` — the MVP in one paragraph, then each acceptance criterion with where it is implemented
   and the test that proves it, and anything in the plan that was not built and why.
3. `## Decisions` — every step's decisions, the ones with the most impact on the user first, each in one or
   two lines: the question, the choice, and why.
4. `## Review history` — for each step, how many review passes ran, what they found, and what was fixed or
   dismissed.
5. `## Test evidence` — the last test and build results each step recorded.

End by telling the operator their choices at the gate: approve as is, which commits and publishes the pull
request description; ask you for changes here first; or send the slice back to RED with a brief, when its tests
missed something, so the slice's steps run again before it comes back to them.

Once you have written the done-signal, stay in this session. When the operator asks for a change, make it
test-first as the repository's standards require, run the tests the repository requires before a pull request,
record it in `impl-report.md` under a `## impl-approve` section as an `Operator decision (<date>): …`, and tell
them what changed and the test result. The operator approves at the gate when they are satisfied.
