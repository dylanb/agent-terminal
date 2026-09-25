import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { createFlowManager } from '../../src/main/flow';
import { createActiveFlowGate } from '../../src/main/activeFlowGate';
import { MAX_ECHOED_REASON_LENGTH } from '../../src/shared/controlChars';
import { readActiveFlow, activeFlowPointerFile, writeActiveFlow } from '../../src/main/activeFlowPointer';
import { recordDisposition } from '../../src/main/runDisposition';
import {
  createWorktreeLock,
  currentLockHolder,
  serializeLockHolder,
  worktreeLockFile,
  type WorktreeLock,
} from '../../src/main/worktreeLock';

// A2 (#133) §18.7.4 AC7/AC11 — the composed write gate: a new active-flow selection (set or clear) is permitted
// ONLY while the run has never started; it is refused once the run has begun, and (fail-closed, CWE-841) while
// begun-ness is indeterminate; a first-step revertStep keeps it locked. The write is serialized under the
// cross-process worktree lock and refused when that lock cannot be taken. Observable behavior over real fixtures:
// a refused write leaves active-flow.yaml byte-for-byte unchanged (§18.7.2 AC8).
describe('createActiveFlowGate — the AC7 started-ness write gate under the AC11 worktree lock (§18.7.4)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  const lockRootFor = (): string => join(fx.outsideDir('a2-gate-home'), 'locks');
  const gateFor = (lock: WorktreeLock = createWorktreeLock({ lockRoot: lockRootFor() })) => createActiveFlowGate(lock);

  it('permits a selection while the run has never started, writing the pointer', () => {
    const wt = fx.makeWorktree('a2-gate-never');
    const res = gateFor().set(wt, 'cat-flow');
    expect(res.ok).toBe(true);
    expect(readActiveFlow(wt)).toEqual({ kind: 'value', id: 'cat-flow' });
  });

  it('refuses an id the pointer reader would reject, leaving the prior selection in place (§18.7.6)', () => {
    const wt = fx.makeWorktree('a2-gate-unsafe-id');
    const gate = gateFor();
    gate.set(wt, 'first');
    const before = readFileSync(activeFlowPointerFile(wt));

    const res = gate.set(wt, 'Feature-Dev');

    expect(res.ok).toBe(false);
    expect(readFileSync(activeFlowPointerFile(wt))).toEqual(before);
  });

  it('AC10: a gated first selection on a worktree with no .agent-terminal creates the path and writes no .gitignore', () => {
    const wt = fx.makeFirstRunWorktree('a2-gate-first-run');
    expect(gateFor().set(wt, 'cat-flow')).toEqual({ ok: true });
    expect(readActiveFlow(wt)).toEqual({ kind: 'value', id: 'cat-flow' });
    expect(existsSync(join(wt, '.gitignore'))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)('surfaces a reason, never a throw, when the permitted write faults', () => {
    const wt = fx.makeWorktree('a2-gate-write-fault');
    mkdirSync(dirname(activeFlowPointerFile(wt)), { recursive: true });
    chmodSync(dirname(activeFlowPointerFile(wt)), 0o555);
    try {
      const res = gateFor().set(wt, 'cat-flow');
      expect(res.ok).toBe(false);
      expect(res.ok ? '' : res.reason).toMatch(/could not be saved/);
    } finally {
      chmodSync(dirname(activeFlowPointerFile(wt)), 0o755);
    }
    expect(readActiveFlow(wt)).toEqual({ kind: 'unset' });
  });

  it.skipIf(process.getuid?.() === 0)('a write-fault reason that echoes a hostile path is display-sanitized and length-bounded (§18.7.6)', () => {
    const wt = fx.makeWorktree(`a2-gate-hostile-${String.fromCharCode(0x202e, 0x200b)}${'p'.repeat(150)}`);
    mkdirSync(dirname(activeFlowPointerFile(wt)), { recursive: true });
    chmodSync(dirname(activeFlowPointerFile(wt)), 0o555);
    try {
      const res = gateFor().set(wt, 'cat-flow');
      const reason = res.ok ? '' : res.reason;
      expect(reason).toMatch(/could not be saved/);
      expect(reason).not.toMatch(/[\u202E\u200B]/u);
      expect(reason.length).toBeLessThanOrEqual(MAX_ECHOED_REASON_LENGTH);
    } finally {
      chmodSync(dirname(activeFlowPointerFile(wt)), 0o755);
    }
  });

  it('refuses a selection once the run has begun, leaving the pointer byte-for-byte unchanged', () => {
    const wt = fx.makeWorktree('a2-gate-begun');
    const gate = gateFor();
    gate.set(wt, 'first'); // a selection stands before the run begins
    const before = readFileSync(activeFlowPointerFile(wt));
    recordDisposition(wt, { source: 'non-catalog' }); // the durable run-begun marker → worktreeStartedness reads 'started'

    const res = gate.set(wt, 'second');

    expect(res.ok).toBe(false);
    expect(readFileSync(activeFlowPointerFile(wt))).toEqual(before);
    expect(readActiveFlow(wt)).toEqual({ kind: 'value', id: 'first' });
  });

  it('refuses while begun-ness is indeterminate, never writing (fail-closed, CWE-841)', () => {
    const wt = fx.makeWorktree('a2-gate-indet');
    // A confinement-escaping flow-state → worktreeStartedness reads 'indeterminate'; the gate must fail closed.
    fx.plantFlowStateEscape(wt, fx.outsideDir('a2-gate-indet-target'));

    const res = gateFor().set(wt, 'x');

    expect(res.ok).toBe(false);
    expect(readActiveFlow(wt)).toEqual({ kind: 'unset' });
  });

  it('stays locked across a first-step revertStep (the durable marker survives the rollback)', () => {
    const wt = fx.makeWorktree('a2-gate-revert');
    const globalDir = fx.makeWorktree('a2-gate-revert-global');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['red', 'green'] });
    const gate = gateFor();
    gate.set(wt, 'first');
    const before = readFileSync(activeFlowPointerFile(wt));

    const mgr = createFlowManager({ globalDir });
    mgr.start(wt); // commits the durable run-begun disposition
    mgr.revertStep(wt, 'red'); // display status back to not_started, but the run HAS begun

    const res = gate.set(wt, 'second');

    expect(res.ok).toBe(false);
    expect(readFileSync(activeFlowPointerFile(wt))).toEqual(before);
  });

  it('refuses with a visible reason when the worktree lock is held by a live peer, leaving the pointer unchanged (AC11)', () => {
    const wt = fx.makeWorktree('a2-gate-lock-held');
    const lockRoot = lockRootFor();
    const gate = gateFor(createWorktreeLock({ lockRoot }));
    gate.set(wt, 'first');
    const before = readFileSync(activeFlowPointerFile(wt));
    const lockFile = worktreeLockFile(lockRoot, wt);
    mkdirSync(dirname(lockFile), { recursive: true });
    writeFileSync(lockFile, serializeLockHolder(currentLockHolder())); // a live holder with a matching identity

    const res = gate.set(wt, 'second');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/\S/);
    expect(readFileSync(activeFlowPointerFile(wt))).toEqual(before);
  });

  it('reads started-ness INSIDE the lock: a flow:start that lands just before the lock is granted refuses the write', () => {
    const wt = fx.makeWorktree('a2-gate-ordering');
    const real = createWorktreeLock({ lockRoot: lockRootFor() });
    // A peer's flow:start commits its run-begun marker while this write is waiting on the lock.
    const racingLock: WorktreeLock = {
      acquire: (dir) => real.acquire(dir),
      withWorktreeLock: (dir, fn) => {
        recordDisposition(dir, { source: 'non-catalog' });
        return real.withWorktreeLock(dir, fn);
      },
    };

    const res = createActiveFlowGate(racingLock).set(wt, 'late');

    expect(res.ok).toBe(false);
    expect(readActiveFlow(wt)).toEqual({ kind: 'unset' });
  });

  it('clears the selection back to the unset default while the run has never started', () => {
    const wt = fx.makeWorktree('a2-gate-clear');
    writeActiveFlow(wt, 'cat-flow');

    const res = gateFor().clear(wt);

    expect(res.ok).toBe(true);
    expect(readActiveFlow(wt)).toEqual({ kind: 'unset' });
  });

  it('refuses to clear the selection once the run has begun, leaving the pointer byte-for-byte unchanged', () => {
    const wt = fx.makeWorktree('a2-gate-clear-begun');
    writeActiveFlow(wt, 'cat-flow');
    const before = readFileSync(activeFlowPointerFile(wt));
    recordDisposition(wt, { source: 'non-catalog' });

    const res = gateFor().clear(wt);

    expect(res.ok).toBe(false);
    expect(readFileSync(activeFlowPointerFile(wt))).toEqual(before);
  });

  it('reports a clear that could not remove the selection instead of claiming success', () => {
    const wt = fx.makeWorktree('a2-gate-clear-fault');
    // A directory planted at the pointer path cannot be removed by the file-clear.
    mkdirSync(join(activeFlowPointerFile(wt), 'nested'), { recursive: true });

    const res = gateFor().clear(wt);

    expect(res.ok).toBe(false);
  });
});
