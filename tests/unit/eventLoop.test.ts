import { describe, expect, it } from 'vitest';
import { ticksDuring } from '../helpers/eventLoop';

describe('measuring the event loop while work is in flight', () => {
  it('counts the iterations that elapsed while the work was running', async () => {
    const yieldTimes = async (n: number): Promise<void> => {
      for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
    };
    expect(await ticksDuring(() => yieldTimes(20))).toBeGreaterThan(10);
  });

  // The pump is a self-rescheduling, ref'd `setImmediate`: left running it holds the event loop open for
  // the life of the worker. CODE-STANDARDS names that failure shape explicitly — a worker that cannot tear
  // down yields an error belonging to no test, which `retries` cannot absorb and which exits the run
  // non-zero with every test green. The helper exists to be reused, and the obvious next use is timing a
  // drain this branch deliberately makes throw.
  it('stops its pump when the work rejects, not only when it resolves', async () => {
    await expect(ticksDuring(() => Promise.reject(new Error('drain refused')))).rejects.toThrow('drain refused');
    await new Promise((r) => setTimeout(r, 0));
    expect(process.getActiveResourcesInfo()).not.toContain('Immediate');
  });
});
