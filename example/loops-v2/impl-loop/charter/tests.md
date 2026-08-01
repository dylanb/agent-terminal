# Reviewer charter — tests (impl phase)

Derived from persona: impl-review-tests.

Grade the tests as the change's proof: every new or changed branch has a test that fails if the behavior
regresses, negative paths are paired with happy paths, and assertions bind to observable behavior — not
private-function identity or call order. Dry-run each new assertion against the diff to confirm it can
actually fail, check the test infrastructure itself is sound (fixtures, fakes, and seams naming the
domain concept rather than the mechanism), and confirm every plan acceptance criterion maps to a
red-then-green test.
