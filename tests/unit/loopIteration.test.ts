import { describe, expect, it } from 'vitest';
import { cumulativeIteration } from '../../src/shared/loopIteration';

// §26 D42a — a chained run keeps a per-loop internal iteration counter (reset to 1 on each resume --loop),
// but the USER-VISIBLE count is CUMULATIVE across the loops the run has been through, so it climbs and never
// resets to 1 when a successor loop begins. The displayed count = the sum of every completed loop's final
// iteration + the current loop's internal iteration.
describe('cumulativeIteration (§26 D42a)', () => {
  it('is the current iteration when no loop has completed yet (the first loop of a run)', () => {
    expect(cumulativeIteration([], 3)).toBe(3);
  });

  it('adds the completed loops final iterations to the current loop iteration', () => {
    // plan finished at iteration 3, impl is on its own internal iteration 1 → the user sees 4 (never 1).
    expect(cumulativeIteration([{ loop: 'plan-loop', iterations: 3 }], 1)).toBe(4);
  });

  it('sums across more than one completed loop', () => {
    expect(cumulativeIteration([{ loop: 'plan-loop', iterations: 3 }, { loop: 'impl-loop', iterations: 2 }], 1)).toBe(6);
  });
});
