import { describe, expect, it } from 'vitest';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';
import config from '../../playwright.config';

// Two hand-maintained numbers in two files, and one is meaningless without the other: Playwright counts
// beforeEach against the per-test `timeout`, so a window budget at or above the cap is a budget the harness
// can never grant. It shipped that way once (90s against a 60s cap), which is why this is a test and not a
// sentence in a comment.

describe('the e2e launch budget fits inside the harness that must grant it', () => {
  const cap = config.timeout;

  it('playwright.config.ts declares a per-test timeout', () => {
    expect(typeof cap).toBe('number');
  });

  it('leaves the test itself room to run after the slowest permitted launch', () => {
    expect(WINDOW_TIMEOUT_MS).toBeLessThan(cap as number);
    // A launch allowed to consume the entire cap would leave zero for the assertions it exists to enable.
    expect((cap as number) - WINDOW_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });

  it('is still more generous than the 30s default it exists to replace', () => {
    expect(WINDOW_TIMEOUT_MS).toBeGreaterThan(30_000);
  });
});
