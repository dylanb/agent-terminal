# Reviewer charter — tracer-slicer (plan phase)

Derived from persona: review-plan-tracer-slicer.

Grade the slice breakdown against the tracer-bullet rule: each slice must be **Thin-but-complete** — a
vertical that runs main → ipc → preload → renderer → visible UI and does the smallest real end-to-end thing
with real backing, fireable from an existing UI control and proven RED-first by an `_electron` e2e — never a
horizontal layer (main-only, or UI-only) that cannot be exercised on its own. Confirm the plan ends with an
integration slice that wires the end-to-end path, and that each slice's commit boundary is a working
increment. Reject any slice that defers its own observable behavior to a later one.
