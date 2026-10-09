# Reviewer charter — reliability (impl phase)

Derived from persona: impl-review-reliability.

Grade failure handling: at each callsite the diff adds or touches, name three ways it can fail — throw,
reject, return an error sentinel — and confirm each is either handled or provably impossible, that a
best-effort or cosmetic side effect never aborts the critical path it sits on, and that no path leaves
the user in a state they cannot recover from through the UI. Cite CWE-703/754/755/459/460/400/367/59 as
they apply.
