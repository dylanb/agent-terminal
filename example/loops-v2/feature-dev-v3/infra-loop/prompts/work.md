# infra-loop — work turn

Build the deterministic test infrastructure the slice plan calls for per `CLAUDE.md`: the harness, fakes,
and fixtures, hermetic and scriptable per turn — no wall-clock, randomness, or network in the seams a test
drives. Read `loop-capabilities.yaml` for the repo's `test_command` and `build_command` the harness wraps.
Leave the built infrastructure in the working tree so the RED/GREEN slices build on it.

## Deterministic capabilities

Beyond the harness, look for deterministic capabilities this ticket's implementation would benefit from. There
are two kinds: ones that steer implementers into consistent, simple, standardized, testable code that agents
can understand and change (a type that makes a wrong state impossible to write, a lint rule that forces use of
the shared helper, a test builder or fixture that makes the right test the easy one, one canonical module per
concern), and ones that let a machine catch a quality problem a reviewer would otherwise have to spot (a
custom lint rule, a parity or contract test, an architecture boundary check, a coverage threshold on the files
the ticket changes). Choose the cheapest mechanism that works: a type, then a lint rule, then a test, then a
script, then a new tool.

Investigate first. Build the harness and every small capability. Never build a large capability or a
follow-up proposal here: each is the operator's call, so log it under Needs your call in your report, in plain
business language and with the full context needed to decide without reading anything else: what it is, the
problem it prevents, what it costs and what it saves for this ticket and for the repository, and your
recommendation. A decision already recorded as `Operator decision (<date>): …` by an earlier run of this step
is settled: keep it, and build a large capability it approved.

Build each capability test-first: show it failing on a violating example before it passes (for a lint rule,
cases it flags and cases it accepts). Wire it into the repository's existing lint, test or build commands so it
runs without anyone remembering it. Where it enforces a written standard, a one-line pointer to it from that
standard is an edit to a standards document, so it goes to the operator like any large item.

Record every capability in `infra-capabilities.md` among this work's flow documents, under three headings: `##
Capabilities built`, `## Large capabilities` and `## Follow-up proposals`. For each item give what it is, the
slice that uses it, the judgment it replaces, its size and its cost. Record each large capability's and each
follow-up's status under it: `Needs your call — see impl-report.md`, or the `Operator decision (<date>): …` that
settled it. Write `None.` under an empty heading.

## Review until clean

1. Do the work above.
2. Run the tests the repository requires before a pull request and confirm they pass. Record the commands and their results under `### Test evidence` before any review, so every
   reviewer reads results that match the change.
3. Review it with the reviewers below, as the review rules in these instructions say.
4. Fix or dismiss every finding, and log each in the report. When a fix changes code or tests, run the tests again and
   update `### Test evidence` before the next pass.
5. Repeat steps 3 and 4 until the review ends, as the review rules in these instructions say.
