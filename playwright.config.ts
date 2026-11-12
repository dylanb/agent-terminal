import { defineConfig } from '@playwright/test';
import { availableParallelism } from 'node:os';
import { resolveE2eWorkers } from './playwright.workers';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  // Worker count (serial in GitHub CI, parallel elsewhere) lives in resolveE2eWorkers.
  workers: resolveE2eWorkers(process.env, availableParallelism()),
  // fullyParallel lets those workers split a single spec across themselves; without it a worker
  // takes a whole file, so the largest spec would pin one worker and starve the rest.
  fullyParallel: true,
  // Retry on CI (GitHub and Podman both set CI) to absorb load-class flakes; a bare local run keeps
  // a failure a failure so it is not silently masked during debugging.
  retries: process.env.CI ? 2 : 0,
  // A committed test.only would narrow a CI run to the focused tests and still pass.
  forbidOnly: !!process.env.CI,
  expect: { timeout: 10_000 },
});
