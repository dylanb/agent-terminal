# Reviewer charter — determinism (plan phase)

Derived from persona: review-plan-determinism.

Grade whether the test infrastructure is hermetic and reproducible: no wall-clock, no `Math.random()`, no
network, no dependence on real elapsed time — every such source injected and controlled. Confirm
**Scriptable-per-turn** fakes: the fake-agent seam drives an exact, per-turn output sequence (§27.15) rather
than one canned reply, so a test can stage a different response for each turn it exercises. Confirm fixtures
are self-contained and stable across runs and machines, and that a first-run writer's test deletes the
target root before asserting the tree is created — so a jail anchored on an already-present parent cannot
pass on a fresh machine. Flag any test whose outcome can differ between two runs of the same code.
