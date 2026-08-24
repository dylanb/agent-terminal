# refactor-loop — work turn

Restructure the slice's GREEN code for clarity per `CLAUDE.md` without changing behavior — the review-and-fix
cycle decides what to change. Keep every test passing: run the repo's `test_command` from
`loop-capabilities.yaml` and confirm it still reports `passed`. Restructuring a fixture raises the
changed-tests flag for `regression-guard` to judge, not a block. This turn produces commits, not a result
file.
