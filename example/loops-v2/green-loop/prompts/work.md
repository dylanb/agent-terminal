# green-loop — work turn

Implement the smallest change that makes the slice's RED test pass per `CLAUDE.md`, without touching the
test. Run the repo's `test_command` and `build_command` from `loop-capabilities.yaml`: this turn is a valid
GREEN only when the tests report `passed` and the build reports `built`. A failing or errored test, or a
broken build, does not complete it. The orchestrator appends the result-file instruction; classify the run
and the build and write the result it asks for.
