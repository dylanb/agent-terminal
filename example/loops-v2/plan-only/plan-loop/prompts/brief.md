# plan-loop — brief

A slice exists so that it can be tested end to end on its own — not so that every piece that *could* be
tested end to end gets a slice of its own. Target **no more than 5 impl-slices** per ticket (a small ticket is
one slice); only the dependency split below may take a ticket past 5, and never past **10**. Aim for slices of **more than 200 lines** changed, and fold any slice below **one eighth** of the
ticket's total estimate into the slice before or after it, carrying all of its ACs. These are planning
guidance for you alone; reviewers do not grade slice count or size.

Split at every RED/GREEN dependency. Each impl-slice runs one RED step, which must see every test in the slice
fail at the check it exists for before any of the slice's production code is written. When a test can reach
its check only once production code that another of the slice's tests drives exists — a command-line flag, a
transport, a service the slice has yet to build — those are two increments: give each its own impl-slice,
ordered by that dependency. Never plan RED/GREEN increments inside one impl-slice; the chain runs one RED, one
GREEN and one refactor per impl-slice, so increments inside one cannot run.
This split overrides every sizing rule above except the limit of 10. A ticket that needs more than 10
dependency-ordered slices is an epic (§28.7), or a decision for the operator when it cannot be split into
sub-tickets.

No acceptance criterion may be deferred, narrowed, or dropped from the plan. Every AC must be assigned to a
slice that implements it, and the final integration slice must wire every AC into production unless the plan
explicitly records that wiring a non-goal. The only way an AC leaves scope is explicit, prior operator
permission (a non-goal recorded in the ticket, or a split into an already-filed sub-ticket of the same epic);
never self-defer an AC to "a later slice" without it.

Your plan is graded by the principal, security, architecture, intent, maintainability, contracts and ui
reviewers. Know the ui reviewer's standards before you start and meet them the first time:

- **ui:** WCAG 2.2 AA, the WAI-ARIA Authoring Practices Guide patterns, design tokens as the single source of a
  design system's values, and atomic design (atoms, molecules and organisms) — plus the repository's own UI
  standards (for example `UI-STANDARDS.md`). It reviews only a plan that touches renderer UI.

When the ticket touches renderer UI, the plan carries a `## Design system` section that lists every
design-system change the work needs — new or changed tokens, new or changed shared components (atoms and
molecules, per `UI-STANDARDS.md`), and the contrast pairings they introduce — or states `None.` when it needs
none. A ticket that does not touch renderer UI omits the section.

Schedule each listed change in the earliest slice or slices, ahead of every slice that uses it, each applied to a
surface the operator can already see (the tracer-bullet rule's design-system note, for example in
`TRACER-BULLET.md`), so later slices consume the design system rather than introduce styling of their own. Never
plan a component-specific colour, spacing or typography value where a token should exist: plan the token in the
design-system section instead.
