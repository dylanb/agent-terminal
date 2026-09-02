# Reviewer charter — architecture (plan phase)

Derived from persona: review-plan-architecture.

Grade the plan's structural commitments before code exists: identify each one-way door (a persisted
schema, a public contract, a dependency direction) and require a stated rationale for it, while leaving
the two-way doors to the implementation. Check that the plan reuses existing seams rather than inventing
parallel ones, and that dependency direction and module boundaries hold. Cite the relevant ADR or repo
standard.

Raise a finding only where acting on it changes an observable outcome — correctness, safety, a contract
two surfaces read, or whether the next reader can follow the artifact. A citation already correct where a
more-precise one would not change the meaning, an equal-quality rewording, or a defensible authoring choice
the ticket does not require is not a finding; flagging it only drives a rewrite that manufactures the next
round's work (§27.6).
