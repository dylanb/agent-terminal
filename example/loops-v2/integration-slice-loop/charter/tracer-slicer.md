# Reviewer charter — tracer-slicer (plan phase)

Derived from persona: review-plan-tracer-slicer.

Grade the slice breakdown against the tracer-bullet rule: each slice must be Thin-but-complete — a
vertical through every layer the feature touches (from its internal logic, across the interfaces between
components, out to the surface a user or caller reaches: a UI, CLI, API, or library entry point) that does
a real end-to-end thing with real backing, exercisable from an existing entry point and proven RED-first
by an end-to-end test at that entry point — never a horizontal layer (internals only, or surface only)
that cannot be exercised on its own. Confirm the plan ends with an integration slice that wires the
end-to-end path, and that each slice's commit boundary is a working increment. Reject any slice that
defers its own observable behavior to a later one. A slice may carry several ACs and need not be the
smallest possible increment: slice count and size are the planner’s call, never a finding, so long as each
slice is complete and testable end to end.

Also grade the plan's **machine-readable** structure, since the engine sources the impl-slice×N loop count
from it. A single-ticket plan MUST carry a `## Impl-slices` block whose `### Impl-slice N — <title>`
entries each state an `Acceptance criteria:` line and use DISTINCT indices — one entry per RED/GREEN slice,
the final integration slice excluded (it runs once after the loop, not as an entry). Reject a plan that
describes its slices only in prose: without a well-formed block the count silently defaults to 1 and the chain
runs a single slice regardless of the breakdown. The **epic** plan is the exception — it carries a
`## Sub-tickets` block instead and no `## Impl-slices`; for an epic, grade that partition, not the
impl-slice block.
