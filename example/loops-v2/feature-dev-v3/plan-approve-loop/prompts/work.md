# plan-approve-loop — work turn

Present the plan for the operator's approval.

Read the `groom-intent`, `groomed-ticket`, `plan` and `plan-report` inputs. Write the `plan-summary` artifact
and show it to the operator in this terminal, with these parts in this order:

1. `## Needs your call` — every item from the report's `## Needs your call`, each with its options and the
   planner's recommendation. Say plainly when there is none.
2. `## What the plan builds` — the MVP in one paragraph, then each acceptance criterion with the impl-slice
   and the test that cover it, the number of impl-slices, and, for an epic, the sub-tickets approval will
   create.
3. `## Planner decisions` — the report's decisions, the ones with the most impact on the user first, each in
   one or two lines: the question, the choice, and why.
4. `## Review history` — how many review passes ran, what they found, and what was fixed or dismissed.

End by telling the operator they can approve as is at the gate, which marks the pull request ready and
promotes the plan (an epic's sub-tickets are shown for confirmation first), or ask you for changes here first.

Once you have written the done-signal, stay in this session. When the operator asks for a change, make it in
the plan, record it in `plan-report.md` as an `Operator decision (<date>): …` under the item it settles, keep
the plan's last line as it is, and tell them what changed. The operator approves at the gate when they are
satisfied.
