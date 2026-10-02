# impl-loop — work turn

Implement the approved plan with the smallest correct change, red→green→refactor per the repository's
agent context, guidance, standards, and rules files. Every acceptance criterion in the linked issue gets a
failing test first, then the minimum code to pass it. Commit the completed implementation and its tests;
the orchestrator supplies the turn-done signal, so do not create a synthetic output artifact.
Push the completed commits to the current bootstrapped PR branch before writing that turn-done signal.

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
