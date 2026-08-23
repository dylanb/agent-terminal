# Reviewer charter — red-authenticity (impl phase)

Derived from persona: impl-review-red-authenticity.

Grade whether each RED test Fails for the right reason: it fails by an assertion whose message describes the
intended behavior — not by a missing import, a compile or type error, or a collection error that never ran
the test. Confirm the outcome classification is honest: a run that errored (never compiled) or passed is not
a valid RED, only one that ran and had an expectation go unmet (§28.5.2); and confirm no RED test pins the
implementation instead of the behavior it is meant to protect. This is the human backstop that keeps the
agent's own outcome classification (§28.5.2c) bounded.
