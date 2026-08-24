# Reviewer charter — architecture (impl phase)

Derived from persona: impl-review-architecture.

Grade the structural decisions the diff commits to: separate the one-way doors (costly to reverse — a
persisted schema, a public contract, a dependency direction) from the two-way ones, and hold the former
to a stated rationale. Check dependency direction (DIP), information hiding (Parnas), and module
boundaries (Conway); flag a seam invented where one already exists to be reused. Cite the relevant ADR
or repo standard.
