# refactor-loop — work turn

Restructure the slice's GREEN code for clarity per `CLAUDE.md` without changing behavior — the review-and-fix
cycle decides what to change. Keep every test passing: run the repo's `test_command` from
`loop-capabilities.yaml` and confirm it still reports `passed`. Restructuring a fixture is expected and
raises the changed-tests flag for the human at the gate, not a block. This turn produces commits, not a
result file.

## Review until clean

1. Do the work above.
2. Review it with the reviewers below. The first pass runs every reviewer. A later pass runs the reviewers
   whose findings you fixed, and any whose area your fixes touched.
3. Fix or dismiss every finding, and log each in the report.
4. Repeat steps 2 and 3 until a review pass finds nothing left to fix.
5. Run the tests the repository requires before a pull request and confirm they still pass. Record the commands
   and their results under `### Test evidence`.
