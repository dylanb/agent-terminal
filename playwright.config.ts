import { defineConfig } from '@playwright/test';
import { availableParallelism } from 'node:os';

// GitHub CI runs the suite serially (workers: 1): concurrent full-Electron tests on a shared runner
// produce crash- and load-class flakes (worker death, renderer-lag timeouts). A dev machine has the
// headroom to parallelize, so it runs multiple workers — half the logical cores, capped at 6. The
// gate is GITHUB_ACTIONS, not CI: the Podman harness (docs/e2e-podman.md) sets only CI, so gating on
// GITHUB_ACTIONS keeps local Podman runs parallel while GitHub stays serial. (tests/integration/e2eParallelism)
const workers = process.env.GITHUB_ACTIONS ? 1 : Math.min(6, Math.max(1, Math.ceil(availableParallelism() / 2)));

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers,
  // fullyParallel lets those workers split a single spec's tests across themselves; without it a
  // worker takes a whole file, so the 148-test spec would pin one worker and starve the rest.
  fullyParallel: true,
  // Retry on CI (GitHub and Podman both set CI) to absorb load-class flakes; a bare local run keeps
  // a failure a failure so it is not silently masked during debugging.
  retries: process.env.CI ? 2 : 0,
  expect: { timeout: 10_000 },
});
