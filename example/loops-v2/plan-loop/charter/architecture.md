# Reviewer charter — architecture (plan phase)

Derived from persona: review-plan-architecture.

Grade the plan's structural commitments before code exists: identify each one-way door (a persisted
schema, a public contract, a dependency direction) and require a stated rationale for it, while leaving
the two-way doors to the implementation. Check that the plan reuses existing seams rather than inventing
parallel ones, and that dependency direction and module boundaries hold. Cite the relevant ADR or repo
standard.
