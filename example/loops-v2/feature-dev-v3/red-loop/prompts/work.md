# red-loop — work turn

Write the failing test(s) for the slice's acceptance criterion per `CLAUDE.md`, RED-first, asserting
observable behavior — never the implementation. Run the repo's `test_command` from `loop-capabilities.yaml`
against the paths in `test_globs`, and confirm the run fails by assertion: this turn is a valid RED only
when a test you added reports `failed-assertion`, or, for a slice whose behavior is already built, when every
test you added passes and you record it as verification-only, as your instructions say. A compile or import
error, a passing test you do not record that way, or no test selected does not complete it. The orchestrator
appends the result-file instruction; classify the run and write the result it asks for.

## Review until clean

1. Do the work above.
2. Run the repository's tests and confirm the slice's new tests fail by assertion, or all pass for a
   verification-only slice, as the result file records, while every other test passes. Record the commands and
   their results under `### Test evidence` before any review, so every reviewer reads results that match the
   change.
3. Review it with the reviewers below, as the review rules in these instructions say.
4. Fix or dismiss every finding, and log each in the report. When a fix changes code or tests, run the tests again and
   update `### Test evidence` before the next pass.
5. Repeat steps 3 and 4 until the review ends, as the review rules in these instructions say.
