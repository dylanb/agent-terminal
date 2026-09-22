# plan-loop — work turn

Produce an implementation plan for the linked issue, decomposed into tracer-bullet slices per
`CLAUDE.md`. Name the architectural sketch, the affected contracts, the file-level change list, and
the test strategy (RED-first, with the Playwright e2e that proves each slice). Emit the plan as the
`plan` artifact.

No acceptance criterion may be deferred, narrowed, or dropped from the plan. Every AC must be assigned to a
slice that implements it, and the final integration slice must wire every AC into production unless the plan
explicitly records that wiring a non-goal. The only way an AC leaves scope is explicit, prior operator
permission (a non-goal recorded in the ticket, or a split into an already-filed sub-ticket of the same epic);
never self-defer an AC to "a later slice" without it.
