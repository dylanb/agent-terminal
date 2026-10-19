# green-loop — work turn

Implement the smallest change that makes the slice's RED test pass per `CLAUDE.md`, without touching the
test. Run the repo's `test_command` and `build_command` from `loop-capabilities.yaml`: this turn is a valid
GREEN only when the tests report `passed` and the build reports `built`. A failing or errored test, or a
broken build, does not complete it. The orchestrator appends the result-file instruction; classify the run
and the build and write the result it asks for.

## Review until clean

1. Do the work above.
2. Run the tests and the build the repository requires before a pull request and confirm they pass. Record the commands and their results under `### Test evidence` before any review, so every
   reviewer reads results that match the change.
3. Review it with the reviewers below, as the review rules in these instructions say.
4. Fix or dismiss every finding, and log each in the report. When a fix changes code or tests, run the tests again and
   update `### Test evidence` before the next pass.
5. Repeat steps 3 and 4 until the review ends, as the review rules in these instructions say.
