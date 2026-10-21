# refactor-loop — work turn

Restructure the slice's GREEN code for clarity per `CLAUDE.md` without changing behavior — your review
passes decide what to change. Keep every test passing: run the repo's `test_command` from
`loop-capabilities.yaml` and confirm it still reports `passed`. Restructuring a fixture or a RED test is
expected; log each RED test file you change under `### RED test changes`. This turn produces commits, and it
records its test result in the phase-result file the orchestrator's instructions name.

## Review until clean

1. Do the work above.
2. Run the tests the repository requires before a pull request and confirm they still pass. Record the commands and their results under `### Test evidence` before any review, so every
   reviewer reads results that match the change.
3. Review it with the reviewers below, as the review rules in these instructions say.
4. Fix or dismiss every finding, and log each in the report. When a fix changes code or tests, run the tests again and
   update `### Test evidence` before the next pass.
5. Repeat steps 3 and 4 until the review ends, as the review rules in these instructions say.
