import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createBenchClock } from '../../src/main/benchRun';

// #180 — the production clock's stamp names one command's run folders and branches, so two commands a moment
// apart never share one, and every branch it names is one git accepts.

describe('the production bench clock', () => {
  it('stamps two commands a millisecond apart differently, each a branch-safe path segment', () => {
    const times = [Date.UTC(2026, 9, 20, 12, 0, 0, 0), Date.UTC(2026, 9, 20, 12, 0, 0, 1)];
    const stamps = times.map((t) => createBenchClock(() => t).stamp());

    const branchOk = (stamp: string): boolean => spawnSync('git', ['check-ref-format', '--branch', `bench/${stamp}/run-1`]).status === 0;
    expect({ distinct: new Set(stamps).size, stamps: stamps.map((s) => ({ segment: /^[A-Za-z0-9._-]+$/.test(s), branch: branchOk(s) })) }).toEqual({
      distinct: 2,
      stamps: [
        { segment: true, branch: true },
        { segment: true, branch: true },
      ],
    });
  });
});
