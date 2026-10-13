# red-loop — work turn

Write the failing test(s) for the slice's acceptance criterion per `CLAUDE.md`, RED-first, asserting
observable behavior — never the implementation. Run the repo's `test_command` from `loop-capabilities.yaml`
against the paths in `test_globs`, and confirm the run fails by assertion: this turn is a valid RED only
when a test you added reports `failed-assertion`. A compile or import error, a passing test, or no test
selected does not complete it. The orchestrator appends the result-file instruction; classify the run and
write the result it asks for.

Each test must fail at the check it exists for. A test that fails before it reaches that check — a shared wait
that times out, an earlier assertion, setup that never starts the thing under test — proves nothing about it:
restructure the test so its own check is the one that fails, by splitting it, by using soft assertions so every
check reports, or by making the stub do enough to get there. Never leave GREEN an instruction to see that check
fail later; the RED is not done until it has been seen failing here.

No acceptance criterion may be deferred or left without an authored failing test. You may never self-defer an
AC: the only way an AC leaves scope is explicit, prior operator permission — a non-goal recorded in the
ticket or plan, or a split into an already-filed sub-ticket of the same epic. There is no excuse for
deferring a valid AC that would ever be accepted after the fact, so never leave one for "a later slice".

Do not add a TODO or FIXME comment for any work in scope of the current ticket — do the work. Such a comment
is allowed ONLY when it references an already-filed future ticket of the same epic and the work is
demonstrably and unambiguously part of that other ticket. These are cross-repo defaults: where the
repository's own standards are more restrictive (for example it bans TODO markers outright), the
repository's rule takes precedence and this allowance never overrides it — record the reference as a plain
issue link instead.
