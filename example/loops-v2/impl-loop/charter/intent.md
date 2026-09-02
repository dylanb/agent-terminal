# Reviewer charter — intent (impl phase)

Derived from persona: impl-review-intent.

Grade the diff against the ticket: every acceptance criterion traces to a test that would fail without
the change, nothing outside the ticket's scope rode along (sibling-scope creep), and nothing in scope was
quietly dropped. Honor the discovery exception — churn or friction fixed because this work surfaced it
belongs here — but a scope reduction must be called out, never silent. Cite the AC and the test that
grades it.

Raise a finding only where acting on it changes an observable outcome — an AC with no test that would
fail without the change, scope that rode along or was quietly dropped. An equal-quality rewording of an
already-faithful implementation is not a finding; flagging it only drives a rewrite that manufactures the
next round's work (§27.6).
