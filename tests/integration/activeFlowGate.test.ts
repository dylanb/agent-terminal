import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
import { expectsUnidentifiedHolderRemedy, tryPeerLockDuring } from '../helpers/lockDevices';

// A2 (#133) §18.7.4 AC7/AC11 — the composed write gate: a new active-flow selection (set or clear) is permitted
// ONLY while the run has never started; it is refused once the run has begun, and (fail-closed, CWE-841) while
// begun-ness is indeterminate; a first-step revertStep unlocks it (v2.155). The write is serialized under the
// cross-process worktree lock and refused while a live or unidentifiable peer holds it (A3 #134 T6c as narrowed at impl round 2). Observable
// behavior over real fixtures: a refused write leaves active-flow.yaml byte-for-byte unchanged (§18.7.2 AC8).
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

  // Operator decision, #134 impl round 6: a first-step rollback deletes the run record, so the run is never-started.
  it('unlocks after a first-step revertStep, writing the new selection', () => {
    const wt = fx.makeWorktree('a2-gate-revert');
    const globalDir = fx.makeWorktree('a2-gate-revert-global');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['red', 'green'] });
    const gate = gateFor();
    gate.set(wt, 'first');

    const mgr = createFlowManager({ globalDir });
    mgr.start(wt); // commits the durable run-begun disposition
    mgr.revertStep(wt, 'red');

    const res = gate.set(wt, 'second');

    expect(res.ok).toBe(true);
    expect(readActiveFlow(wt)).toEqual({ kind: 'value', id: 'second' });
  });

  it('refuses with a visible reason when the worktree lock is held by a live peer, leaving the pointer unchanged (AC11)', () => {
    const wt = fx.makeWorktree('a2-gate-lock-held');
    const lockRoot = lockRootFor();
    const gate = gateFor(createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' }));
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

  describe('only an unusable lock lets the write run without it (A3 #134 T6c as narrowed at impl round 2)', () => {
    it('a peer holder whose identity cannot be read refuses the write, and its lockfile is unchanged', () => {
      const wt = fx.makeWorktree('a3-gate-unreadable-holder');
      const lockRoot = lockRootFor();
      const lockFile = worktreeLockFile(lockRoot, wt);
      mkdirSync(dirname(lockFile), { recursive: true });
      writeFileSync(lockFile, serializeLockHolder(currentLockHolder()));
      const before = readFileSync(lockFile);
      writeActiveFlow(wt, 'prior');
      const pointerBefore = readFileSync(activeFlowPointerFile(wt));

      const res = gateFor(createWorktreeLock({ lockRoot, holderLiveness: () => 'unreadable' })).set(wt, 'picked');

      expect(res.ok).toBe(false);
      if (!res.ok) expectsUnidentifiedHolderRemedy(res.reason, lockFile);
      expect(readFileSync(activeFlowPointerFile(wt))).toEqual(pointerBefore);
      expect(readFileSync(lockFile)).toEqual(before);
    });

    it('a lock root that is a regular file does not block the write, and the file is unchanged', () => {
      const wt = fx.makeWorktree('a3-gate-lock-unusable');
      const lockRoot = lockRootFor();
      mkdirSync(dirname(lockRoot), { recursive: true });
      writeFileSync(lockRoot, 'not a directory\n');

      const res = gateFor(createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' })).set(wt, 'picked');

      expect(res).toEqual({ ok: true });
      expect(readActiveFlow(wt)).toEqual({ kind: 'value', id: 'picked' });
      expect(readFileSync(lockRoot, 'utf8')).toBe('not a directory\n');
    });

    const probedGate = (lockRoot: string, wt: string) => {
      const probe = tryPeerLockDuring(lockRoot, wt);
      const real = createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' });
      const probing: WorktreeLock = {
        acquire: (dir) => real.acquire(dir),
        withWorktreeLock: (dir, fn) => real.withWorktreeLock(dir, probe.wrap(fn)),
      };
      return { gate: createActiveFlowGate(probing), probe };
    };

    it.each([
      ['a deleted lock root', (lockRoot: string) => rmSync(lockRoot, { recursive: true, force: true })],
      ['a deleted app home', (lockRoot: string) => rmSync(dirname(lockRoot), { recursive: true, force: true })],
    ] as const)('with %s the lock is rebuilt and really held while the pointer is written', (_label, remove) => {
      const wt = fx.makeWorktree('a3-gate-rebuild');
      const lockRoot = lockRootFor();
      mkdirSync(lockRoot, { recursive: true });
      remove(lockRoot);
      const { gate, probe } = probedGate(lockRoot, wt);

      expect(gate.set(wt, 'picked')).toEqual({ ok: true });

      expect(probe.observed()).not.toHaveLength(0);
      for (const attempt of probe.observed()) expect(attempt).toMatchObject({ ok: false, cause: 'held' });
      expect(readActiveFlow(wt)).toEqual({ kind: 'value', id: 'picked' });
    });
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

  it('"use the default" removes a non-file planted at the pointer path, returning the worktree to unset (#134)', () => {
    const wt = fx.makeWorktree('a3-gate-clear-nonfile');
    const outside = fx.outsideDir('a3-gate-clear-outside');
    const sentinel = join(outside, 'keep.txt');
    writeFileSync(sentinel, 'outside the worktree\n');
    const planted = fx.plantPointerDirectory(wt);
    symlinkSync(outside, join(planted, 'escape'));

    const res = gateFor().clear(wt);

    expect(res).toEqual({ ok: true });
    expect(readActiveFlow(wt)).toEqual({ kind: 'unset' });
    expect(existsSync(activeFlowPointerFile(wt))).toBe(false);
    expect(readFileSync(sentinel, 'utf8')).toBe('outside the worktree\n');
  });

  it.skipIf(process.getuid?.() === 0)(
    'reports a clear that could not remove the selection instead of claiming success',
    () => {
      const wt = fx.makeWorktree('a2-gate-clear-fault');
      const stuck = join(fx.plantPointerDirectory(wt), 'stuck');
      mkdirSync(stuck);
      writeFileSync(join(stuck, 'occupant'), 'x\n');
      chmodSync(stuck, 0o500);
      try {
        const res = gateFor().clear(wt);

        expect(res.ok).toBe(false);
        expect(existsSync(activeFlowPointerFile(wt))).toBe(true);
      } finally {
        chmodSync(stuck, 0o700);
      }
    },
  );
});
