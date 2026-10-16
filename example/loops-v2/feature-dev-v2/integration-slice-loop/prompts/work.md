# integration-slice-loop — work turn

Wire the slices together end-to-end per `CLAUDE.md` and author the integration `_electron` e2e that fires
the feature from an existing UI control on a real PTY. Run the full suite — the repo's `test_command` and
`build_command` from `loop-capabilities.yaml`, then the Playwright e2e — and confirm it is green before the
gate. This turn produces commits; the gate publishes the PR body.
