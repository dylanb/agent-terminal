# infra-loop — work turn

Build the deterministic test infrastructure the slice plan calls for per `CLAUDE.md`: the harness, fakes,
and fixtures, hermetic and scriptable per turn — no wall-clock, randomness, or network in the seams a test
drives. Read `loop-capabilities.yaml` for the repo's `test_command` and `build_command` the harness wraps.
Leave the built infrastructure in the working tree so the RED/GREEN slices build on it.

No acceptance criterion may be deferred, partially implemented, or left unwired. You may never self-defer an
AC: the only way an AC leaves scope is explicit, prior operator permission — a non-goal recorded in the
ticket or plan, or a split into an already-filed sub-ticket of the same epic. There is no excuse for
deferring a valid AC that would ever be accepted after the fact, so never leave one for "a later slice".

Do not add a TODO or FIXME comment for any work in scope of the current ticket — do the work. Such a comment
is allowed ONLY when it references an already-filed future ticket of the same epic and the work is
demonstrably and unambiguously part of that other ticket. These are cross-repo defaults: where the
repository's own standards are more restrictive (for example it bans TODO markers outright), the
repository's rule takes precedence and this allowance never overrides it — record the reference as a plain
issue link instead.
