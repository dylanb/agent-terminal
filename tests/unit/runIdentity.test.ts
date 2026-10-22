import { describe, expect, it } from 'vitest';
import { runKeyOf, sameRun } from '../../src/shared/runIdentity';

// §27.9.1 — the renderer keys a run with runKeyOf and main compares runs with sameRun; the two must agree.

describe('a run’s key', () => {
  const runs = [
    { flow: 'feature-dev-v3', startedAt: 1 },
    { flow: 'feature-dev-v3', startedAt: 2 },
    { flow: 'other', startedAt: 1 },
    { flow: 'a","b', startedAt: 1 },
    { flow: 'a', startedAt: 1 },
    { flow: '"a"', startedAt: 1 },
  ];

  it('is equal for two runs exactly when they are the same run', () => {
    for (const a of runs) {
      for (const b of runs) expect(runKeyOf(a) === runKeyOf(b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(sameRun(a, b));
    }
    expect(runKeyOf({ flow: 'x', startedAt: 5 })).toBe(runKeyOf({ flow: 'x', startedAt: 5 }));
  });
});
