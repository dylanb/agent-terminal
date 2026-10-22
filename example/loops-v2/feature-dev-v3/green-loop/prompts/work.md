# green-loop — work turn

Implement the smallest change that makes the slice's RED test pass per `CLAUDE.md`. Change a line of a test
RED wrote only when that test is wrong, as your decision boundary says. You may add new tests, in new test files or added to RED's files
without editing their lines, when your change needs coverage RED's tests do not give, such as a branch or
failure path your design introduces. Each added test must test observable behaviour, never the
implementation, and must not weaken any other test: no shared setup, hook, mock or skip it adds may change
what another test checks. Write it before the code it covers and run it to see it fail, as `CLAUDE.md`
requires, and record that under `### Test evidence`. Run the repo's `test_command` and `build_command` from `loop-capabilities.yaml`: this turn is a valid
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
