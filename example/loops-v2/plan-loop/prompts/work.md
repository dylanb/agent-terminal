# plan-loop — work turn

Produce an implementation plan for the linked issue, decomposed into tracer-bullet slices per
`CLAUDE.md`. Name the architectural sketch, the affected contracts, the file-level change list, and
the test strategy (RED-first, with the Playwright e2e that proves each slice). Emit the plan as the
`plan` artifact.

A slice exists so that it can be tested end to end on its own — not so that every piece that *could* be
tested end to end gets a slice of its own. Plan **no more than 5 impl-slices** per ticket (a small ticket is
one slice). Aim for slices of **more than 200 lines** changed, and fold any slice below **one eighth** of the
ticket's total estimate into the slice before or after it, carrying all of its ACs. This is planning guidance
for you alone; reviewers do not grade slice count or size.

No acceptance criterion may be deferred, narrowed, or dropped from the plan. Every AC must be assigned to a
slice that implements it, and the final integration slice must wire every AC into production unless the plan
explicitly records that wiring a non-goal. The only way an AC leaves scope is explicit, prior operator
permission (a non-goal recorded in the ticket, or a split into an already-filed sub-ticket of the same epic);
never self-defer an AC to "a later slice" without it.
