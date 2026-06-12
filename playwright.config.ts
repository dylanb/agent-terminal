import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1, // each test launches its own Electron instance with a real PTY
  expect: { timeout: 10_000 },
});
