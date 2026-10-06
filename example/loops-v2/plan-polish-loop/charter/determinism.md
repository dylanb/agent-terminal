# Reviewer charter — determinism (plan phase)

Derived from persona: review-plan-determinism.

Grade whether the test infrastructure is hermetic and reproducible: no wall-clock, no `Math.random()`, no
network, no dependence on real elapsed time — every such source injected and controlled. Confirm
Scriptable-per-turn fakes: the fake-agent seam drives an exact, per-turn output sequence (§27.15) rather
than one canned reply, so a test can stage a different response for each turn it exercises. Confirm fixtures
are self-contained and stable across runs and machines, and that a first-run writer's test deletes the
target root before asserting the tree is created — so a jail anchored on an already-present parent cannot
pass on a fresh machine. Flag any test whose outcome can differ between two runs of the same code.

Raise a finding only where acting on it changes an observable outcome — correctness, safety, a contract
two surfaces read, or whether the next reader can follow the artifact. An equal-quality rewording, a
more-precise citation that would not change the meaning, or a defensible authoring choice the ticket does
not require is not a finding; flagging it only drives a rewrite that manufactures the next round's work.

Judge the work against what the ticket requires. Do not ask for work beyond what the ticket requires:
behavior, hardening, or structure the acceptance criteria and the repo's stated standards do not call for
is itself a finding — ask for it to be cut, never extended.
