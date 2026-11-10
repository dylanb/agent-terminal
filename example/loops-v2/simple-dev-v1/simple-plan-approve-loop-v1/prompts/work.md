# simple-plan-approve-loop-v1 — work turn

Present the plan for the operator's approval.

Read the `groom-intent`, `plan` and `plan-report` inputs and the ticket. Write the `plan-summary` artifact and
show it to the operator in this terminal, with these parts in this order:

1. `## Fit for simple-dev` — when the plan's `Simple-dev fit:` is `no`, or the `## Fit` block is missing, open
   with a warning headed **Better suited to feature-dev-v3**: each rule that fails, its evidence in one line,
   what `feature-dev-v3` would do differently, and that the way to switch is to terminate this run and start the
   ticket under `feature-dev-v3`. When the verdict is `yes`, one line saying so with the size estimate. Check the
   verdict against the plan yourself: when an increment, the size estimate or the scope contradicts it, say so
   and warn as for `no`.
2. `## Needs more scrutiny` — every item under the plan's `## Scrutiny flags`: what is new, and the reviews this
   flow skips that it would benefit from. Recommend `feature-dev-v3` when an item is a new trust boundary, a
   destructive or outward-facing operation, or a new persisted format two components read. Say plainly when
   there is none.
3. `## Intent` — the `groom-intent` MVP, scope, non-goals and decision boundary in a few lines each, since the
   operator settles them here for the first time.
4. `## Needs your call` — every item from the report's `## Needs your call`, each with its options and the
   planner's recommendation. Say plainly when there is none.
5. `## What the plan builds` — the MVP in one paragraph, then each acceptance criterion with the increment and
   the test that cover it.
6. `## Planner decisions` — the report's decisions, the ones with the most impact on the user first, each in
   one or two lines: the question, the choice, and why.
7. `## Review history` — how many review passes ran, what they found, and what was fixed or dismissed.

End by telling the operator they can approve as is at the gate, which marks the pull request ready and
promotes the plan, ask you for changes here first, or, after a warning, terminate the run and start again under
`feature-dev-v3`.

Once you have written the done-signal, stay in this session. When the operator asks for a change, make it in
the plan or the intent, record it as an `Operator decision (<date>): …` in `plan-report.md` under the item it
settles and, for a change to the intent, under `## Operator decisions` in `groom-intent.md`; keep the plan's last
line as it is, and tell them what changed. The operator approves at the gate when they are satisfied.
