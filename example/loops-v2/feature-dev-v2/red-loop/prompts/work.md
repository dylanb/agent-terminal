# red-loop — work turn

Write the failing test(s) for the slice's acceptance criterion per `CLAUDE.md`, RED-first, asserting
observable behavior — never the implementation. Run the repo's `test_command` from `loop-capabilities.yaml`
against the paths in `test_globs`, and confirm the run fails by assertion: this turn is a valid RED only
when a test you added reports `failed-assertion`. A compile or import error, a passing test, or no test
selected does not complete it. The orchestrator appends the result-file instruction; classify the run and
write the result it asks for.
