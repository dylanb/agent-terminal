import { describe, it, expect, afterEach } from 'vitest';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { createFlowManager } from '../../src/main/flow';
import { worktreeStartedness } from '../../src/main/startedness';

// A2 (#133) §18.7.4 AC7 — the run-started-ness that gates a new active-flow selection keys on a DURABLE
// "run has begun" disposition, NOT the load-maskable display status. A run that HAS begun and then had its
// FIRST step rolled back (`revertStep` returns the flow-state status to `not_started`, a recoverable state,
// flow.ts) must STILL read 'started', so a new pointer selection stays LOCKED: the run began, and only a
// Terminate returns the worktree to a state where a new selection may be written (§18.7.2/§18.7.4). A
// classifier that keys on the on-disk display status alone reads the reverted record 'never-started' and
// unlocks the gate mid-run — the CWE-841 fail-open this accessor exists to prevent, and the exact branch the
// slice-5 GREEN deferred behind `startedness.ts`'s durable-marker composition.
//
// Observable behavior over the REAL production wiring (no mocks): a real FlowManager drives the real
// start()→revertStep() lifecycle against the worktree's real flow-state store, and the shared
// worktreeStartedness accessor — the one both the main-side write gate and A3's picker-enable read — classifies
// the resulting on-disk state. The durable disposition is written atomically with the transition to
// `in_progress` (§18.7.3 AC9) and cleared only by a Terminate (§18.7.2 AC6), so it survives the rollback.
describe('worktreeStartedness — a begun run stays started across a first-step revertStep (§18.7.4 AC7)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  it("reads 'started' after start() then a first-step revertStep() rolls the on-disk status back to not_started", () => {
    const wt = fx.makeWorktree('a2-revert-locked');
    const globalDir = fx.makeWorktree('a2-revert-global');
    // An unset pointer's local flow.yaml (leg 2) so the run resolves without a catalog; `red` is the first step revertStep targets.
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['red', 'green'] });

    const mgr = createFlowManager({ globalDir });
    mgr.start(wt); // not_started → in_progress; the transition commits the durable run-begun disposition
    // A first-step rollback returns the persisted status to `not_started` (flow.ts revertStep: a first-step loop
    // has no previous step). The run HAS begun, so the durable disposition must keep the selection locked — a
    // status-only classifier reads this exact state 'never-started' and re-opens the gate (CWE-841).
    mgr.revertStep(wt, 'red');

    expect(worktreeStartedness(wt)).toBe('started');
  });
});
