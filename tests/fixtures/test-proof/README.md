# Test-proof oracle fixtures

Hand-written reports for the `pnpm run test:proof` result readers (#283). They follow the shapes vitest's built-in
`json` reporter and Playwright's `json` reporter write. Those shapes were checked against real reports generated
on 2026-11-03 (vitest 4.1.10, @playwright/test 1.61.0). They import nothing and are not generated from
the readers. Within each fixture the non-zero counts all differ. `vitest-fail.json` and both Playwright fixtures
tell every pair of counts apart. `vitest-pass.json` cannot tell failed from flaky (both 0, and vitest's flaky
count is always 0 because the proof runs it with retries off), so a test for swapped counts uses `vitest-fail.json`.

`passed` includes flaky tests. `flaky` is the subset of `passed` that needed a retry. vitest's `skipped`, `todo`
and `pending` statuses all count as skipped.

| File | Reads as |
|------|----------|
| `vitest-pass.json` | passed 6, failed 0, skipped 4, flaky 0. Skipped: `alpha is skipped on purpose`, `beta is also skipped`, `beta is still todo` (todo), `is pending` (pending, no describe). |
| `vitest-fail.json` | the `vitest-pass.json` tests plus `gamma breaks` failed: passed 6, failed 1, skipped 4. |
| `vitest-file-error.json` | a test file that failed to load (`delta.test.ts`, file `status: failed`, no assertion results) beside a passing file. Must read as failed, though `numFailedTests` is 0. |
| `vitest-missing-results.json` | no `testResults`: unreadable. |
| `playwright-pass.json` | passed 7 (`stats.expected` 5 + `stats.flaky` 2), failed 0, skipped 3, flaky 2. Flaky: `retries a paste`, `waits for quiet` (in describe `monitor`). Skipped: `skips on linux` (in `monitor`), `skips the slow path`, `skips the gate`. |
| `playwright-fail.json` | the `playwright-pass.json` tests plus `breaks` (`broken.spec.ts`), unexpected after its retries: passed 7, failed 1, skipped 3, flaky 2. |
| `playwright-load-error.json` | a spec file that failed to load: all `stats` 0 and one top-level `errors` entry. Must read as failed, never as an empty pass. |
| `playwright-missing-stats.json` | no `stats`: unreadable. |
| `unparsable.json` | truncated JSON: unreadable as either report. |
| `environment.json` | node `v22.11.0`, electron `39.2.4`, image `sha256:5d1f…bdf0`. |
| `environment-missing-image.json` | no `image` key: unreadable. |
