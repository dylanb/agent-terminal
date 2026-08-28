# infra-loop — work turn

Build the deterministic test infrastructure the slice plan calls for per `CLAUDE.md`: the harness, fakes,
and fixtures, hermetic and scriptable per turn — no wall-clock, randomness, or network in the seams a test
drives. Read `loop-capabilities.yaml` for the repo's `test_command` and `build_command` the harness wraps.
Commit the infrastructure so the RED/GREEN slices can build on it.
