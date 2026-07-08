import { describe, expect, it } from 'vitest';
import { resumeRebindWrite } from '../../src/main/loopRebind';
import type { LoopDef } from '../../src/main/loopDef';

// §26 D42a (resume --loop) — the pure computation that rebinds an existing run to a NEW loop. It reads the
// carried run identity (pr/branch/linked_issues) and the new loop's first phase, and produces the fresh
// (freshExtension) state write + the work phase to drive. It never re-uses the prior loop's internal
// counters — the new loop starts at iteration 1 with its own entry status.

const def = (over: Partial<LoopDef> = {}): LoopDef => ({
  name: 'impl-loop',
  gates: [],
  phases: [{ id: 'impl', entryStatus: 'impl-draft', rosterOverrideId: '', postCleanGate: '', postNeedsWorkGate: '', iterationCap: 0 }],
  rosters: [],
  defaultRosterId: '',
  artifacts: {},
  ...over,
});

const prior = { pr: 50, branch: 'plan-loop/issue-40', linkedIssues: [40], iteration: 3, boundLoop: 'plan-loop', completedLoops: [] };

describe('resumeRebindWrite (§26 D42a)', () => {
  it('records the completing loop (name + final iteration) into completed_loops for the cumulative count', () => {
    const w = resumeRebindWrite(prior, 'impl-loop', def())!.write;
    expect(w.completedLoops).toEqual([{ loop: 'plan-loop', iterations: 3 }]);
  });

  it('appends to an existing chain when the prior run had already been through loops', () => {
    const w = resumeRebindWrite(
      { ...prior, boundLoop: 'impl-loop', iteration: 2, completedLoops: [{ loop: 'plan-loop', iterations: 3 }] },
      'polish-loop',
      def(),
    )!.write;
    expect(w.completedLoops).toEqual([{ loop: 'plan-loop', iterations: 3 }, { loop: 'impl-loop', iterations: 2 }]);
  });

  it('rebinds to the new loop at its first phase entry status, iteration reset to 1', () => {
    const r = resumeRebindWrite(prior, 'impl-loop', def());
    expect(r).not.toBeNull();
    expect(r!.workPhase).toBe('impl');
    expect(r!.write.status).toBe('impl-draft');
    expect(r!.write.iteration).toBe(1);
    expect(r!.write.boundLoop).toBe('impl-loop');
    expect(r!.write.freshExtension).toBe(true);
  });

  it('carries the run identity (pr/branch/linked_issues) so the new loop keeps working the same PR', () => {
    const w = resumeRebindWrite(prior, 'impl-loop', def())!.write;
    expect(w.pr).toBe(50);
    expect(w.branch).toBe('plan-loop/issue-40');
    expect(w.linkedIssues).toEqual([40]);
  });

  it('returns null when the new loop def has no phase to enter (nothing to drive)', () => {
    expect(resumeRebindWrite(prior, 'impl-loop', def({ phases: [] }))).toBeNull();
  });
});
