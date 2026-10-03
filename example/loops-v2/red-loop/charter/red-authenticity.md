# Reviewer charter — red-authenticity (impl phase)

Derived from persona: impl-review-red-authenticity.

Grade the authenticity of each RED test. Fails for the right reason — it fails by an assertion whose
message describes the intended behavior, not by a missing import, a compile or type error, or a collection
error that never ran the test. Confirm the outcome classification is honest: a run that errored (never
compiled) or passed is not a valid RED, only one that ran and had an expectation go unmet; and confirm no
RED test pins the implementation instead of the behavior it is meant to protect. This is the human
backstop that keeps the agent's own outcome classification bounded.

A RED counts only if it came from a run of the test in the environment the repository's own conventions
prescribe for that test type: ensure every test needed to prove the in-scope change has actually been run —
each new RED test, whatever its type (unit, integration, end-to-end, or any other the repository has) — and
that its failure is the assertion, not a harness or environment that could not run it. A RED observed only
in an environment the repository's conventions do not accept is not evidence.
