// The e2e's per-launch window budget. It lives here, not inline in the spec file, because it is only
// meaningful against playwright.config.ts's per-test `timeout` — which counts beforeEach against it, so a
// budget larger than the cap is one the harness can never grant. That invariant is asserted by
// tests/unit/e2eBudget.test.ts, because a comment cannot fail when it is violated (and it was: this value
// shipped at 90s against a 60s cap).

/** How long a cold Electron launch may take to produce its window before the test gives up. */
export const WINDOW_TIMEOUT_MS = 45_000;
