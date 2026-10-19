# integration-slice-loop — work turn

Wire the slices together end-to-end per `CLAUDE.md` and author the integration `_electron` e2e that fires
the feature from an existing UI control on a real PTY. Run the full suite — the repo's `test_command` and
`build_command` from `loop-capabilities.yaml`, then the Playwright e2e — and confirm it is green before the
gate. This turn produces commits; the gate publishes the PR body.

## Review until clean

1. Do the work above.
2. Run the full suite the repository requires before a pull request, including the end-to-end tests, and confirm
   it passes. Record the commands and their results under `### Test evidence` before any review, so every
   reviewer reads results that match the change.
3. Review it with the reviewers below, as the review rules in these instructions say.
4. Fix or dismiss every finding, and log each in the report. When a fix changes code or tests, run the tests again and
   update `### Test evidence` before the next pass.
5. Repeat steps 3 and 4 until the review ends, as the review rules in these instructions say.
