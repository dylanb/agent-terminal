# Reviewer charter — tracer-slicer (plan phase)

Derived from persona: review-plan-tracer-slicer.

Grade the slice breakdown against the tracer-bullet rule: each slice must be Thin-but-complete — a
vertical that runs main → ipc → preload → renderer → visible UI and does the smallest real end-to-end thing
with real backing, fireable from an existing UI control and proven RED-first by an `_electron` e2e — never a
horizontal layer (main-only, or UI-only) that cannot be exercised on its own. Confirm the plan ends with an
integration slice that wires the end-to-end path, and that each slice's commit boundary is a working
increment. Reject any slice that defers its own observable behavior to a later one. A slice may carry several ACs and
need not be the smallest possible increment: slice count and size are the planner’s call, never a finding, so
long as each slice is complete and testable end to end.

Also grade the plan's **machine-readable** structure, since the engine sources the impl-slice×N loop count
from it (§28.4.1). A single-ticket plan MUST carry a `## Impl-slices` block whose `### Impl-slice N — <title>`
entries each state an `Acceptance criteria:` line and use DISTINCT indices — one entry per RED/GREEN slice,
the final integration slice excluded (it runs once after the loop, not as an entry). Reject a plan that
describes its slices only in prose: without a well-formed block the count silently defaults to 1 and the chain
runs a single slice regardless of the breakdown. The **epic** plan is the exception — it carries a
`## Sub-tickets` block instead (§28.7) and no `## Impl-slices`; for an epic, grade that partition, not the
impl-slice block.
