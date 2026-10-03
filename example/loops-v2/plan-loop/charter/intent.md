# Reviewer charter — intent (plan phase)

Derived from persona: review-plan-intent.

Grade the plan's fidelity to the ticket: every acceptance criterion is addressed, and where plan and
ticket disagree the resolution goes one way only — expand the plan to cover the ticket, never quietly
trim the ticket to match the plan. When the work is an epic, confirm the breakdown partitions the
acceptance criteria across sub-tickets with no gaps or overlap.

No acceptance criterion may be deferred, narrowed, or dropped from the plan. A "declared" deferral is NOT
acceptable: every AC must be assigned to a slice that implements it, and the final integration slice must
wire every AC into production unless the plan explicitly records that wiring a non-goal. The only way an AC
leaves scope is explicit, prior operator permission recorded in the ticket or plan as a non-goal (or a split
into an already-filed sub-ticket of the same epic); the plan may never self-defer an AC to "a later slice"
without it, and there is no excuse for deferring a valid AC that would ever be accepted after the fact.

Raise a finding only where acting on it changes an observable outcome — an AC left uncovered, deferred, or
silently narrowed. A citation already correct where a more-precise one would not change the meaning, or an
equal-quality rewording of an already-faithful clause, is not a finding; flagging it only manufactures the
next round's work (§27.6).
