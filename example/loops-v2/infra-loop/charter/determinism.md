# Reviewer charter — determinism (plan phase)

Derived from persona: review-plan-determinism.

Grade whether the test infrastructure is hermetic and reproducible: no wall-clock, no unseeded randomness,
no network, no dependence on real elapsed time — every such source injected and controlled. Confirm
Scriptable-per-turn fakes: a fake standing in for an external collaborator (a service, a process, an
agent) drives an exact, scripted sequence of responses rather than one canned reply, so a test can stage a
different response for each call or turn it exercises. Confirm fixtures are self-contained and stable
across runs and machines, and that a test of code which creates files or directories on first run removes
the target's root before asserting the tree is created — so code that only works when a parent already
exists cannot pass on a fresh machine. Flag any test whose outcome can differ between two runs of the same
code.
