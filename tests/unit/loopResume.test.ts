import { describe, expect, it } from 'vitest';
import { decideResume, type ResumeInputs } from '../../src/main/loopResume';

// §26.11 — auto-resume from state.yaml. On launch (or cd into a managed repo) the orchestrator resumes an
// in-flight run at the recorded status/iteration, honoring the bound LoopDef's resume_contract rather than
// blindly re-injecting: it re-enters the EARLIEST turn of the iteration whose artifact is not yet present
// (so a crash mid-fan-out does not re-spawn every reviewer or re-run completed work), and rewinds to the
// iteration start only when mid_iter_safe is false. `decideResume` is the pure core.
//
// Work-completion FOR THIS ITERATION is proven only by an iteration-scoped downstream artifact (a review or
// the consolidated verdict) — plan.md is a single file rewritten in place, NOT iteration-stamped, so its
// bare presence cannot attribute the plan to the current iteration. Without such proof resume re-enters
// work (regenerating plan.md), never grading a stale prior-iteration plan.
describe('decideResume (§26.11)', () => {
  const PHASES = [{ id: 'plan', entryStatus: 'plan-draft' }];
  const base = (over: Partial<ResumeInputs> = {}): ResumeInputs => ({
    status: 'plan-draft',
    iteration: 2,
    phases: PHASES,
    midIterSafe: true,
    artifacts: { reviewsStarted: false, reviewsComplete: false, consolidated: false },
    ...over,
  });

  it('a gate status is human-owned — no auto-resume (the mirror presents it)', () => {
    expect(decideResume(base({ status: 'awaiting-human-plan-approval' }))).toEqual({ kind: 'none' });
  });

  it('a terminal / error status does not resume', () => {
    expect(decideResume(base({ status: 'plan-human-approved' }))).toEqual({ kind: 'none' });
    expect(decideResume(base({ status: 'impasse' }))).toEqual({ kind: 'none' });
    expect(decideResume(base({ status: 'error' }))).toEqual({ kind: 'none' });
  });

  it('mid-work with no downstream artifact re-enters the work turn', () => {
    expect(
      decideResume(base({ artifacts: { reviewsStarted: false, reviewsComplete: false, consolidated: false } })),
    ).toEqual({ kind: 'work', phaseId: 'plan', iteration: 2 });
  });

  it('a stale plan.md with no iteration-scoped review re-enters work, NOT reviewers (never grades a stale plan)', () => {
    // The re-iteration crash case: plan.md from the prior iteration survives, but no review for THIS
    // iteration exists. Bare plan.md presence is not iteration-scoped proof, so resume must redo work.
    expect(
      decideResume(base({ iteration: 2, artifacts: { reviewsStarted: false, reviewsComplete: false, consolidated: false } })),
    ).toEqual({ kind: 'work', phaseId: 'plan', iteration: 2 });
  });

  it('a partial fan-out (some reviews present, not all) resumes the reviewers turn', () => {
    expect(
      decideResume(base({ artifacts: { reviewsStarted: true, reviewsComplete: false, consolidated: false } })),
    ).toEqual({ kind: 'reviewers', phaseId: 'plan', iteration: 2 });
  });

  it('all reviews present but no consolidated re-enters the consolidate turn (not work/reviewers)', () => {
    expect(
      decideResume(base({ artifacts: { reviewsStarted: true, reviewsComplete: true, consolidated: false } })),
    ).toEqual({ kind: 'consolidate', phaseId: 'plan', iteration: 2 });
  });

  it('all iteration artifacts present re-runs only the post-consolidate branch (no turn re-injected)', () => {
    expect(
      decideResume(base({ artifacts: { reviewsStarted: true, reviewsComplete: true, consolidated: true } })),
    ).toEqual({ kind: 'post-consolidate', phaseId: 'plan', iteration: 2 });
  });

  it('mid_iter_safe false rewinds to the work turn regardless of which artifacts survived', () => {
    expect(
      decideResume(
        base({ midIterSafe: false, artifacts: { reviewsStarted: true, reviewsComplete: true, consolidated: false } }),
      ),
    ).toEqual({ kind: 'work', phaseId: 'plan', iteration: 2 });
  });
});
