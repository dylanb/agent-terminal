import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { createFlowManager } from '../../src/main/flow';
import { setActiveFlowGated } from '../../src/main/activeFlowGate';
import { readActiveFlow, activeFlowPointerFile } from '../../src/main/activeFlowPointer';
import { recordDisposition } from '../../src/main/runDisposition';

// A2 (#133) §18.7.4 AC7 — the composed write gate: a new active-flow selection is permitted ONLY while the run
// has never started; it is refused once the run has begun, and (fail-closed, CWE-841) while begun-ness is
// indeterminate; a first-step revertStep keeps it locked. Observable behavior over real fixtures (no mocks):
// the real worktreeStartedness + writeActiveFlow, with a refused write leaving active-flow.yaml byte-for-byte
// unchanged (§18.7.2 AC8).
describe('setActiveFlowGated — the AC7 started-ness write gate (§18.7.4)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  it('permits a selection while the run has never started, writing the pointer', () => {
    const wt = fx.makeWorktree('a2-gate-never');
    const res = setActiveFlowGated(wt, 'cat-flow');
    expect(res.ok).toBe(true);
    expect(readActiveFlow(wt)).toEqual({ kind: 'value', id: 'cat-flow' });
  });

  it('refuses a selection once the run has begun, leaving the pointer byte-for-byte unchanged', () => {
    const wt = fx.makeWorktree('a2-gate-begun');
    setActiveFlowGated(wt, 'first'); // a selection stands before the run begins
    const before = readFileSync(activeFlowPointerFile(wt));
    recordDisposition(wt, { source: 'non-catalog' }); // the durable run-begun marker → worktreeStartedness reads 'started'

    const res = setActiveFlowGated(wt, 'second');

    expect(res.ok).toBe(false);
    expect(readFileSync(activeFlowPointerFile(wt))).toEqual(before);
    expect(readActiveFlow(wt)).toEqual({ kind: 'value', id: 'first' });
  });

  it('refuses while begun-ness is indeterminate, never writing (fail-closed, CWE-841)', () => {
    const wt = fx.makeWorktree('a2-gate-indet');
    // A confinement-escaping flow-state → worktreeStartedness reads 'indeterminate'; the gate must fail closed.
    fx.plantFlowStateEscape(wt, fx.outsideDir('a2-gate-indet-target'));

    const res = setActiveFlowGated(wt, 'x');

    expect(res.ok).toBe(false);
    expect(readActiveFlow(wt)).toEqual({ kind: 'unset' });
  });

  it('stays locked across a first-step revertStep (the durable marker survives the rollback)', () => {
    const wt = fx.makeWorktree('a2-gate-revert');
    const globalDir = fx.makeWorktree('a2-gate-revert-global');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['red', 'green'] });
    setActiveFlowGated(wt, 'first');
    const before = readFileSync(activeFlowPointerFile(wt));

    const mgr = createFlowManager({ globalDir });
    mgr.start(wt); // commits the durable run-begun disposition
    mgr.revertStep(wt, 'red'); // display status back to not_started, but the run HAS begun

    const res = setActiveFlowGated(wt, 'second');

    expect(res.ok).toBe(false);
    expect(readFileSync(activeFlowPointerFile(wt))).toEqual(before);
  });
});
