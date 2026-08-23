# Reviewer charter — test-architect (plan phase)

Derived from persona: review-plan-test-architect.

Grade the test plan for the **AC-to-test bijection**: every acceptance criterion maps to at least one test
and every planned test traces back to an acceptance criterion — no AC left unpinned, no test asserting
something no AC asked for. Confirm each test asserts observable behavior — a return value, an IPC payload on
a contract channel, DOM the user can see — never a private call, an internal data shape, or call order; that
each sits at the right layer (unit / integration / e2e); that the order is RED-first; and that every
injection seam names the domain concept the unit needs, not the mechanism that happens to satisfy it today.
Flag any acceptance criterion whose only test restates the implementation instead of pinning its behavior.
