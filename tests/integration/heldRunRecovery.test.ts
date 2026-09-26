import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { createCatalogFixture } from '../helpers/catalogFixture';
import { flowCatalogDir, flowHomeDir } from '../../src/main/flow';
import { activeFlowPointerFile, writeActiveFlow } from '../../src/main/activeFlowPointer';
import { runDispositionFile } from '../../src/main/runDisposition';
import {
  createWorktreeLock,
  currentLockHolder,
  serializeLockHolder,
  worktreeLockFile,
  type WorktreeLock,
} from '../../src/main/worktreeLock';
import { createHeldRunRecovery, realHeldRunRecoveryDeps, type HeldRead, type HeldRunRecoveryDeps } from '../../src/main/heldRunRecovery';
import { heldRunOf } from '../../src/main/runHoldRead';
import { MAX_ECHOED_REASON_LENGTH } from '../../src/shared/controlChars';
import type { RebindChoice, RebindResult } from '../../src/shared/ipc';

// A3 (#134) §18.7.3 / §18.7.4 AC17 — a rebind is decided at the operation, never trusted from the renderer: a
// worktree that is not held (never started, intact record, or an indeterminate progression) is refused and every
// run file is left byte-for-byte unchanged.

type Snapshot = { kind: 'absent' } | { kind: 'file'; bytes: string } | { kind: 'link'; to: string } | { kind: 'dir'; names: string[] };

function snapshot(file: string): Snapshot {
  if (!existsSync(file) && !lstatExists(file)) return { kind: 'absent' };
  const st = lstatSync(file);
  if (st.isSymbolicLink()) return { kind: 'link', to: readlinkSync(file) };
  if (st.isDirectory()) return { kind: 'dir', names: readdirSync(file).sort() };
  return { kind: 'file', bytes: readFileSync(file).toString('base64') };
}

function lstatExists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

const CHOICES: RebindChoice[] = [{ origin: 'local' }, { origin: 'global', id: 'resume-flow' }, { origin: 'repo', id: 'repo-flow' }, { origin: 'fallback' }];

const NOT_HELD = /not waiting to be recovered/i;

const realDeps = (globalDir: string): Omit<HeldRunRecoveryDeps, 'lock'> => realHeldRunRecoveryDeps(globalDir);

function expectRefused(result: RebindResult): string {
  expect(result).toMatchObject({ ok: false });
  const reason = result.ok ? '' : result.reason;
  expect(reason).toMatch(/\S/);
  expect(reason).not.toMatch(/[‮​\u0000-\u001F]/);
  expect(reason.length).toBeLessThanOrEqual(MAX_ECHOED_REASON_LENGTH);
  return reason;
}

function expectRefusedAsNotHeld(result: RebindResult): void {
  expect(expectRefused(result)).toMatch(NOT_HELD);
}

describe('flow:rebindHeldRun refuses a worktree that is not held and changes nothing (AC17)', () => {
  const fx = createWorktreeFixture();
  const catalog = createCatalogFixture();
  afterEach(() => {
    fx.cleanup();
    catalog.cleanup();
  });

  function rig(lock?: WorktreeLock) {
    const home = fx.makeWorktree('a3-rebind-home');
    const lockRoot = join(fx.outsideDir('a3-rebind-locks'), 'locks');
    catalog.addEntryWithSteps(flowCatalogDir(home), 'resume-flow', ['s1', 's2', 's3']);
    fx.writeFlowHome(home, { name: 'global-fallback', stepIds: ['s1', 's2'] });
    const wt = fx.makeWorktree('a3-rebind-wt');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['s1', 's2', 's3'] });
    catalog.addEntryWithSteps(flowCatalogDir(wt), 'repo-flow', ['s1', 's2']);
    writeActiveFlow(wt, 'resume-flow');
    const theLock = lock ?? createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' });
    const recovery = createHeldRunRecovery({ lock: theLock, ...realDeps(home) });
    const files = (): Snapshot[] =>
      [join(flowHomeDir(wt), 'flow-state.yaml'), runDispositionFile(wt), activeFlowPointerFile(wt)].map(snapshot);
    return { wt, home, lockRoot, recovery, files };
  }

  it.each(CHOICES)('a never-started worktree is refused for %o, and no run file changes', (choice) => {
    const { wt, recovery, files } = rig();
    const before = files();

    expectRefusedAsNotHeld(recovery.rebind(wt, choice));

    expect(files()).toEqual(before);
  });

  it.each(CHOICES)('a begun run with an intact record is refused for %o, and no run file changes', (choice) => {
    const { wt, recovery, files } = rig();
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.writeRunRecord(wt, { source: 'catalog', tier: 'global', id: 'resume-flow' });
    const before = files();

    expectRefusedAsNotHeld(recovery.rebind(wt, choice));

    expect(files()).toEqual(before);
  });

  it.each([
    ['missing', (wt: string) => fx.removeRunRecord(wt)],
    ['garbage', (wt: string) => fx.writeRunRecordRaw(wt, '[unterminated flow sequence')],
  ] as const)('a not_started progression with the record %s is refused as not held, and no run file changes', (_label, damage) => {
    const { wt, recovery, files } = rig();
    fx.writeFlowState(wt, { step: 's1', status: 'not_started' });
    damage(wt);
    const before = files();

    for (const choice of CHOICES) expectRefusedAsNotHeld(recovery.rebind(wt, choice));

    expect(files()).toEqual(before);
  });

  const INDETERMINATE: [string, (wt: string) => void][] = [
    ['unreadable (a directory at flow-state.yaml)', (wt) => mkdirSync(join(flowHomeDir(wt), 'flow-state.yaml'), { recursive: true })],
    ['unparseable (garbage YAML)', (wt) => fx.writeFlowStateRaw(wt, '[unterminated flow sequence')],
    ['a begun status with no step', (wt) => fx.writeFlowStateRaw(wt, 'status: in_progress\n')],
    ['a step with no status', (wt) => fx.writeFlowStateRaw(wt, 'step: s2\n')],
    ['a status outside the persistable vocabulary', (wt) => fx.writeFlowStateRaw(wt, 'step: s2\nstatus: paused\n')],
  ];

  it.each(INDETERMINATE)('an indeterminate progression — %s — with the record missing is refused, and no run file changes', (_label, plant) => {
    const { wt, recovery, files } = rig();
    plant(wt);
    fx.removeRunRecord(wt);
    const before = files();

    for (const choice of CHOICES) expectRefusedAsNotHeld(recovery.rebind(wt, choice));

    expect(files()).toEqual(before);
  });

  it('a held run is refused while a live peer holds the worktree lock, and no run file changes', () => {
    const { wt, lockRoot, recovery, files } = rig();
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.writeRunRecordRaw(wt, '[unterminated flow sequence');
    const lockFile = worktreeLockFile(lockRoot, wt);
    mkdirSync(dirname(lockFile), { recursive: true });
    writeFileSync(lockFile, serializeLockHolder(currentLockHolder()));
    const lockRefusal = createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' }).acquire(wt);
    expect(lockRefusal.ok).toBe(false);
    const before = files();

    const locked = expectRefused(recovery.rebind(wt, { origin: 'global', id: 'resume-flow' }));

    expect(locked).toContain(lockRefusal.ok ? '' : lockRefusal.reason);

    expect(files()).toEqual(before);
  });

  it('the held check runs while the rebind holds the worktree lock, so a peer cannot take it meanwhile', () => {
    const wt = fx.makeWorktree('a3-rebind-probe-wt');
    const lockRoot = join(fx.outsideDir('a3-rebind-probe-locks'), 'locks');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['s1', 's2'] });
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    const peer = createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' });
    const peerTook: boolean[] = [];
    const tryPeerLockDuring = (read: (worktree: string) => HeldRead) => (worktree: string): HeldRead => {
      const attempt = peer.acquire(worktree);
      peerTook.push(attempt.ok);
      if (attempt.ok) attempt.release();
      return read(worktree);
    };
    const recovery = createHeldRunRecovery({
      ...realDeps(fx.makeWorktree('a3-rebind-probe-home')),
      lock: createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' }),
      hold: tryPeerLockDuring(heldRunOf),
    });

    recovery.rebind(wt, { origin: 'local' });

    expect(peerTook.length).toBeGreaterThan(0);
    expect(peerTook.at(-1)).toBe(false);
  });
});
