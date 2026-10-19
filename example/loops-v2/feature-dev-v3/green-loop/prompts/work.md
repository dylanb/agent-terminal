# green-loop — work turn

Implement the smallest change that makes the slice's RED test pass per `CLAUDE.md`, without touching the
test. Run the repo's `test_command` and `build_command` from `loop-capabilities.yaml`: this turn is a valid
GREEN only when the tests report `passed` and the build reports `built`. A failing or errored test, or a
broken build, does not complete it. The orchestrator appends the result-file instruction; classify the run
and the build and write the result it asks for.

## Review until clean

1. Do the work above.
2. Review it with the reviewers below. The first pass runs every reviewer. A later pass runs the reviewers
   whose findings you fixed, and any whose area your fixes touched.
3. Fix or dismiss every finding, and log each in the report.
4. Repeat steps 2 and 3 until a review pass finds nothing left to fix other than documentation-only fixes recorded as `fixed — documentation`.
5. Run the tests and the build the repository requires before a pull request and confirm they pass. Record the
   commands and their results under `### Test evidence`.
