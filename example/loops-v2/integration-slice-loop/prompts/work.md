# integration-slice-loop — work turn

Wire the slices together end-to-end per the repository's agent context, guidance, standards, and rules
files and author the integration `_electron` e2e that fires the feature from an existing UI control on a
real PTY. Run the full suite — the repo's `test_command` and `build_command` from
`loop-capabilities.yaml`, then the Playwright e2e — and confirm it is green before the gate. This turn
produces commits; the gate publishes the PR body.

This is the integration gate for the whole plan: every acceptance criterion of every slice must be fully
implemented AND wired into production — reachable and exercised from the real UI/product surface, not only in
tests — before this turn signals done, UNLESS the plan explicitly records that AC or that wiring as a
non-goal. A partially-wired or engine-only AC is not done here.

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
