import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1, // each test launches its own Electron instance with a real PTY
  // A single-worker, full-Electron suite on a shared CI runner produces crash- and load-class
  // flakes (worker death, renderer-lag timeouts) that re-run clean. Retry on CI only; locally a
  // failure stays a failure so it is not silently masked during debugging.
  retries: process.env.CI ? 2 : 0,
  expect: { timeout: 10_000 },
});
