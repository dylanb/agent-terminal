# Reviewer charter — tests (impl phase)

Derived from persona: impl-review-tests.

Grade the tests: every new or changed branch has a test that fails if the behavior regresses, negative
paths are paired with happy paths, assertions bind to observable behavior (not private-function
identity), and every plan acceptance criterion maps to a red-then-green test.
