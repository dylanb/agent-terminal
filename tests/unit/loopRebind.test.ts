import { describe, expect, it } from 'vitest';
import { planStepResume, resumeRebindWrite } from '../../src/main/loopRebind';
import type { LoopDef } from '../../src/main/loopDef';

// §26 D42a (resume --loop) — the pure computation that rebinds an existing run to a NEW loop. It reads the
// carried run identity (pr/branch/linked_issues) and the new loop's first phase, and produces the fresh
// (freshExtension) state write + the work phase to drive. It never re-uses the prior loop's internal
// counters — the new loop starts fresh at its own entry status — EXCEPT the run's iteration, which is a
// single MONOTONIC counter across every loop the run passes through (ai-deque parity): it carries forward
// (+1) rather than resetting, so reviews/<iter>/ never collide across loops and the user-visible count is
// the running total. Per-loop "what to track" (severity cycle, persona state) is what resets, not iteration.

const def = (over: Partial<LoopDef> = {}): LoopDef => ({
  name: 'impl-loop',
  gates: [],
  phases: [{ id: 'impl', entryStatus: 'impl-draft', rosterOverrideId: '', postCleanGate: '', postNeedsWorkGate: '', iterationCap: 0 }],
  rosters: [],
  defaultRosterId: '',
  artifacts: {},
  workArtifact: '',
  origin: 'operator-config',
  ...over,
});

const prior = { pr: 50, branch: 'plan-loop/issue-40', linkedIssues: [40], iteration: 3 };

describe('resumeRebindWrite (§26 D42a)', () => {
  it('carries the iteration forward monotonically (prior + 1), never resetting to 1', () => {
    // The prior (plan) loop finished at iteration 3, so the successor (impl) loop's first turn is iteration
    // 4 — the counter climbs across the loop boundary. This is what keeps reviews/<iter>/ from colliding
    // (impl writes reviews/4/, not reviews/1/ over the plan loop's reviews) and makes the displayed count
    // the running total across loops.
    const w = resumeRebindWrite(prior, 'impl-loop', def())!.write;
    expect(w.iteration).toBe(4);
  });

  it('opens a fresh per-loop cap window: cap_baseline = the prior loop final iteration (§26.6/§26.8)', () => {
    // The successor loop's first turn is iteration 4, and cap_baseline = prior.iteration = 3, so its
    // internal cap count is (4 - 3) = 1 — a full per-loop cap budget regardless of how many iterations the
    // prior loop consumed.
    const w = resumeRebindWrite(prior, 'impl-loop', def())!.write;
    expect(w.capBaseline).toBe(3);
  });

  it('rebinds to the new loop at its first phase entry status with a fresh extension', () => {
    const r = resumeRebindWrite(prior, 'impl-loop', def());
    expect(r).not.toBeNull();
    expect(r!.workPhase).toBe('impl');
    expect(r!.write.status).toBe('impl-draft');
    expect(r!.write.boundLoop).toBe('impl-loop');
    expect(r!.write.freshExtension).toBe(true); // the new loop's per-loop counters reset, not iteration
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

// §26 D42a — entering a loop step is now AUTOMATIC (the gate approve advances the flow), so the human is
// not watching at the moment it happens. Every way this can fail must therefore name itself: a step that
// cannot be driven and says nothing leaves the flow parked on it with no turn, no Retry, and no error —
// the unrecoverable dead end CLAUDE.md forbids.
describe('planStepResume (§26 D42a — no silent refusal to enter a loop step)', () => {
  const prior = { pr: 50, branch: 'plan-loop/issue-40', linkedIssues: [40], iteration: 3 };

  it('plans the rebind + work phase when the run and the def are both present', () => {
    const plan = planStepResume(prior, 'impl-loop', def());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.workPhase).toBe('impl');
    expect(plan.write.iteration).toBe(4);
  });

  it('refuses with a reason when the step names a loop whose def is missing or unparseable', () => {
    const plan = planStepResume(prior, 'impl-loop', null);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain('impl-loop');
  });

  it('refuses with a reason when there is no run on disk to rebind onto', () => {
    const plan = planStepResume(null, 'impl-loop', def());
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).not.toBe('');
  });

  it('refuses with a reason when the def declares no phase to drive', () => {
    const plan = planStepResume(prior, 'impl-loop', def({ phases: [] }));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).not.toBe('');
  });
});
