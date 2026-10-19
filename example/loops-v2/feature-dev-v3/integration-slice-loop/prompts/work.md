# integration-slice-loop — work turn

Wire the slices together end-to-end per `CLAUDE.md` and author the integration `_electron` e2e that fires
the feature from an existing UI control on a real PTY. Run the full suite — the repo's `test_command` and
`build_command` from `loop-capabilities.yaml`, then the Playwright e2e — and confirm it is green before the
gate. This turn produces commits; the gate publishes the PR body.

## Review until clean

1. Do the work above.
2. Review it with the reviewers below. The first pass runs every reviewer. A later pass runs the reviewers
   whose findings you fixed, and any whose area your fixes touched.
3. Fix or dismiss every finding, and log each in the report.
4. Repeat steps 2 and 3 until a review pass finds nothing left to fix other than documentation-only fixes recorded as `fixed — documentation`.
5. Run the full suite the repository requires before a pull request, including the end-to-end tests, and confirm
   it passes. Record the commands and their results under `### Test evidence`.
