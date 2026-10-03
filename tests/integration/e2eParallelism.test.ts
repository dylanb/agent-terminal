import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveE2eWorkers } from '../../playwright.workers';
import config from '../../playwright.config';

// resolveE2eWorkers (playwright.workers.ts) is the pure decision behind config.workers, and that
// module documents why the gate is GITHUB_ACTIONS rather than CI. Pinning it with concrete
// (env, cores) pairs exercises the cap/floor branches and the CI-vs-GITHUB_ACTIONS split
// deterministically, whatever machine the suite happens to run on.
describe('resolveE2eWorkers', () => {
  it('is serial under GitHub Actions regardless of core count', () => {
    expect(resolveE2eWorkers({ GITHUB_ACTIONS: 'true' }, 32)).toBe(1);
    expect(resolveE2eWorkers({ GITHUB_ACTIONS: 'true', CI: 'true' }, 8)).toBe(1);
  });

  it('stays parallel when only CI is set (the Podman harness case)', () => {
    expect(resolveE2eWorkers({ CI: 'true' }, 8)).toBe(4);
  });

  it('parallelizes at half the cores off a dev machine', () => {
    expect(resolveE2eWorkers({}, 8)).toBe(4);
    expect(resolveE2eWorkers({}, 7)).toBe(4);
  });

  it('caps at 6 workers however many cores there are', () => {
    expect(resolveE2eWorkers({}, 12)).toBe(6);
    expect(resolveE2eWorkers({}, 16)).toBe(6);
    expect(resolveE2eWorkers({}, 64)).toBe(6);
  });

  it('never drops below 1 worker on a low-core machine', () => {
    expect(resolveE2eWorkers({}, 2)).toBe(1);
    expect(resolveE2eWorkers({}, 1)).toBe(1);
  });
});

describe('playwright.config wiring', () => {
  it('delegates workers to resolveE2eWorkers', () => {
    expect(config.workers).toBe(resolveE2eWorkers(process.env, availableParallelism()));
  });

  it('enables fullyParallel so workers split a single spec', () => {
    expect(config.fullyParallel).toBe(true);
  });
});

describe('playwright.config provisions Electron before workers start', () => {
  it('runs a global setup that leaves the Electron executable present', async () => {
    expect(config.globalSetup).toBeTruthy();
    const setup = (await import(resolve(__dirname, '..', '..', String(config.globalSetup)))) as { default: () => unknown };
    await setup.default();
    expect(existsSync(createRequire(__filename)('electron') as string)).toBe(true);
  });
});
