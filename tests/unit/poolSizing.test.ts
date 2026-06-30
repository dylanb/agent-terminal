import { describe, expect, it } from 'vitest';
import { maxWorkersForEnv } from '../../vitest.poolSizing';

// The fs.watch-backed suites (agentLoopBridge / viewerWatch) drop or stall events on macOS FSEvents
// when many test-file forks contend for the run loop, so a local full-suite run caps parallelism;
// CI hosts are dedicated and stay unrestricted. The cap mirrors vitest's own `'17%'` rounding
// (getWorkersCountByPercentage): Math.round(0.17*n) clamped to [1, n].
describe('vitest local worker cap', () => {
  it('caps a local run to ~17% of available parallelism, matching vitest percentage rounding', () => {
    expect(maxWorkersForEnv({ availableParallelism: 10, isCI: false })).toBe(2); // round(1.7)=2
    expect(maxWorkersForEnv({ availableParallelism: 16, isCI: false })).toBe(3); // round(2.72)=3
    expect(maxWorkersForEnv({ availableParallelism: 8, isCI: false })).toBe(1); // round(1.36)=1
  });

  it('never drops below one worker', () => {
    expect(maxWorkersForEnv({ availableParallelism: 4, isCI: false })).toBe(1); // round(0.68)=1 via floor
    expect(maxWorkersForEnv({ availableParallelism: 1, isCI: false })).toBe(1);
  });

  it('never exceeds available parallelism', () => {
    expect(maxWorkersForEnv({ availableParallelism: 1, isCI: false })).toBeLessThanOrEqual(1);
  });

  it('leaves CI runs unrestricted (undefined → vitest default)', () => {
    expect(maxWorkersForEnv({ availableParallelism: 10, isCI: true })).toBeUndefined();
    expect(maxWorkersForEnv({ availableParallelism: 1, isCI: true })).toBeUndefined();
  });
});
