### Severity floor for THIS iteration: `{{SEVERITY_FLOOR}}`

Drop findings below the floor; do NOT re-classify them upward.

Floor semantics (the rules below apply to whichever floor is set above — the cycle at which each floor lands is loop-defined and may differ across runs):

- Floor `minor`: emit at every severity.
- Floor `major`: emit only `major`/`blocker`; silently drop `minor`.
- Floor `blocker`: emit only `blocker`; non-blockers go to consolidator follow-up routing.

Inflating severity to survive the floor is process abuse and shows up in the audit. A legitimate minor dropped on a `major`-floor cycle is correct behavior.

