import { availableParallelism } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The e2e suite runs serially in GitHub CI (full-Electron tests flake under concurrency on a shared
// runner) but parallel on a dev machine, where there is headroom. The gate is GITHUB_ACTIONS, not CI,
// because the Podman harness (docs/e2e-podman.md) also sets CI — gating on CI would drag local Podman
// runs back to serial. These pins hold that split: swap the gate to CI, drop the cap, or forget
// fullyParallel and one of them fails.
async function loadPlaywrightConfig() {
  vi.resetModules();
  return (await import('../../playwright.config')).default;
}

describe('e2e Playwright parallelism', () => {
  const original = process.env.GITHUB_ACTIONS;
  afterEach(() => {
    if (original === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = original;
  });

  it('runs serially under GitHub Actions, whatever the runner core count', async () => {
    process.env.GITHUB_ACTIONS = 'true';
    const config = await loadPlaywrightConfig();
    expect(config.workers).toBe(1);
  });

  it('parallelizes on a dev machine at half the cores, capped at 6', async () => {
    delete process.env.GITHUB_ACTIONS;
    const config = await loadPlaywrightConfig();
    // fullyParallel is what lets those workers split a single spec — required for the speedup.
    expect(config.fullyParallel).toBe(true);
    const expected = Math.min(6, Math.max(1, Math.ceil(availableParallelism() / 2)));
    expect(config.workers).toBe(expected);
    expect(config.workers).toBeLessThanOrEqual(6);
  });
});
