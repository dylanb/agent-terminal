# refactor-loop — work turn

Restructure the slice's GREEN code for clarity per the repository's agent context, guidance, standards,
and rules files without changing behavior — the review-and-fix cycle decides what to change. Keep every
test passing: run the repo's `test_command` from `loop-capabilities.yaml` and confirm it still reports
`passed`. Restructuring a fixture is expected and raises the changed-tests flag for the human at the gate,
not a block. This turn produces commits, not a result file.

No acceptance criterion may be deferred, dropped, or regressed. You may never self-defer an AC: the only way
an AC leaves scope is explicit, prior operator permission — a non-goal recorded in the ticket or plan, or a
split into an already-filed sub-ticket of the same epic. There is no excuse for deferring a valid AC that
would ever be accepted after the fact, so never leave one for "a later slice".

Do not add a TODO or FIXME comment for any work in scope of the current ticket — do the work. Such a comment
is allowed ONLY when it references an already-filed future ticket of the same epic and the work is
demonstrably and unambiguously part of that other ticket. These are cross-repo defaults: where the
repository's own standards are more restrictive (for example it bans TODO markers outright), the
repository's rule takes precedence and this allowance never overrides it — record the reference as a plain
issue link instead.
