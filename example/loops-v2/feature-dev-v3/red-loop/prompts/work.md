# red-loop — work turn

Write the failing test(s) for the slice's acceptance criterion per `CLAUDE.md`, RED-first, asserting
observable behavior — never the implementation. Run the repo's `test_command` from `loop-capabilities.yaml`
against the paths in `test_globs`, and confirm the run fails by assertion: this turn is a valid RED only
when a test you added reports `failed-assertion`. A compile or import error, a passing test, or no test
selected does not complete it. The orchestrator appends the result-file instruction; classify the run and
write the result it asks for.

## Review until clean

1. Do the work above.
2. Review it with the reviewers below. The first pass runs every reviewer. A later pass runs the reviewers
   whose findings you fixed, and any whose area your fixes touched.
3. Fix or dismiss every finding, and log each in the report.
4. Repeat steps 2 and 3 until a review pass finds nothing left to fix.
5. Run the repository's tests and confirm the slice's new tests fail by assertion, as the result file records,
   while every other test passes. Record the commands and their results under `### Test evidence`.
