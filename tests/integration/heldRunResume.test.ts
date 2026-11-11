import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { createCatalogFixture } from '../helpers/catalogFixture';
import { expectsUnidentifiedHolderRemedy, tryPeerLockDuring } from '../helpers/lockDevices';
import { createFlowManager, flowCatalogDir, flowHomeDir } from '../../src/main/flow';
import { activeFlowPointerFile, readActiveFlow, writeActiveFlow } from '../../src/main/activeFlowPointer';
import { clearDisposition, readRunBinding } from '../../src/main/runDisposition';
import { createRunResolver } from '../../src/main/runResolver';
import { createWorktreeLock, currentLockHolder, serializeLockHolder, worktreeLockFile, type WorktreeLock } from '../../src/main/worktreeLock';
import * as recoveryModule from '../../src/main/heldRunRecovery';
import { productionRecoveryDeps } from '../helpers/heldRunRecoveryDeps';
import { heldRunOf } from '../../src/main/runHoldRead';
import { listCatalog } from '../../src/main/flowCatalogList';
import { MAX_ECHOED_LOCK_REASON_LENGTH, MAX_ECHOED_REASON_LENGTH } from '../../src/shared/controlChars';
import type { DispositionRead } from '../../src/main/resolveRunDefinition';
import type { RebindChoice, RebindResult } from '../../src/shared/ipc';
import { repoOnlyDefTiers } from '../helpers/defTiers';
import { FLOW_DEF_FILE } from '../../src/main/flowHome';

// A3 (#134) §18.7.3 / §18.7.4 AC12 / AC13 / AC15 — recovering a held run onto a flow that contains its current step
// resumes it there: the step and status are unchanged, the selection is unchanged, the chosen flow is recorded as
// the run's binding, and the next flow.state (and a relaunch) shows the chosen flow. Real files, production deps.

const asRoot = process.getuid?.() === 0;

type RealDeps = Omit<recoveryModule.HeldRunRecoveryDeps, 'lock'>;

const realDeps = (globalDir: string): RealDeps => productionRecoveryDeps(globalDir);

const bytes = (file: string): string | null => (existsSync(file) ? readFileSync(file).toString('base64') : null);

function expectCleanReason(result: RebindResult, bound = MAX_ECHOED_REASON_LENGTH): string {
  expect(result).toMatchObject({ ok: false });
  const reason = result.ok ? '' : result.reason;
  expect(reason).toMatch(/\S/);
  expect(reason).not.toMatch(/[‮​\u0000-\u001F]/);
  expect(reason.length).toBeLessThanOrEqual(bound);
  return reason;
}

describe('recovering a held run onto a flow containing its step resumes it (AC12, AC13, AC15)', () => {
  const fx = createWorktreeFixture();
  const catalog = createCatalogFixture();
  afterEach(() => {
    fx.cleanup();
    catalog.cleanup();
  });

  function rig(opts: { local?: boolean; fallback?: boolean; lock?: (lockRoot: string) => WorktreeLock } = {}) {
    const home = fx.makeWorktree('a3-resume-home');
    const lockRoot = join(fx.outsideDir('a3-resume-locks'), 'locks');
    catalog.addEntryWithSteps(flowCatalogDir(home), 'resume-flow', ['s1', 's2', 'global-3']);
    catalog.addEntryWithSteps(flowCatalogDir(home), 'no-s2-flow', ['x1', 'x2']);
    if (opts.fallback !== false) fx.writeFlowHome(home, { name: 'global-fallback', stepIds: ['s1', 's2', 'fallback-3'] });
    const wt = fx.makeWorktree('a3-resume-wt');
    if (opts.local !== false) fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['s1', 's2', 'local-3'] });
    catalog.addEntryWithSteps(flowCatalogDir(wt), 'repo-flow', ['s1', 's2', 'repo-3']);
    writeActiveFlow(wt, 'no-s2-flow');
    const lock = opts.lock?.(lockRoot) ?? createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' });
    const deps = realDeps(home);
    const recovery = recoveryModule.createHeldRunRecovery({ lock, ...deps });
    const manager = () => createFlowManager({ globalDir: home, loadDefinition: (repoKey) => createRunResolver(home, repoOnlyDefTiers())(repoKey) });
    const progressionFile = join(flowHomeDir(wt), 'flow-state.yaml');
    const unchanged = () => [bytes(progressionFile), bytes(activeFlowPointerFile(wt))];
    return { home, wt, lockRoot, deps, recovery, manager, unchanged };
  }

  const CHOICES: [RebindChoice, DispositionRead, string][] = [
    [{ origin: 'global', id: 'resume-flow' }, { source: 'catalog', tier: 'global', id: 'resume-flow' }, 'global-3'],
    [{ origin: 'repo', id: 'repo-flow' }, { source: 'catalog', tier: 'repo', id: 'repo-flow' }, 'repo-3'],
    [{ origin: 'local' }, { source: 'non-catalog' }, 'local-3'],
    [{ origin: 'fallback' }, { source: 'fallback' }, 'fallback-3'],
  ];
  const STATUSES: ('in_progress' | 'done')[] = ['in_progress', 'done'];
  const RECORDS: [string, (wt: string) => void][] = [
    ['missing', (wt) => fx.removeRunRecord(wt)],
    ['garbage YAML', (wt) => fx.writeRunRecordRaw(wt, '[unterminated flow sequence')],
    ['a symlink', (wt) => {
      const outside = join(fx.outsideDir('a3-resume-record-target'), 'record.yaml');
      writeFileSync(outside, 'schema_version: 1\nsource: non-catalog\n');
      fx.plantRunRecordSymlink(wt, outside);
    }],
    ['a directory', (wt) => fx.plantRunRecordDirectory(wt)],
  ];

  for (const [record, damage] of RECORDS) {
    for (const status of STATUSES) {
      it.each(CHOICES)(`record ${record}, ${status}: choosing %o resumes at s2 with the status and selection unchanged`, (choice, binding, lastStep) => {
        const { wt, recovery, manager, unchanged } = rig();
        fx.writeFlowState(wt, { step: 's2', status });
        damage(wt);
        const before = unchanged();

        expect(recovery.rebind(wt, choice, 'refuse')).toEqual({ ok: true, outcome: 'resumed' });

        const view = manager().state(wt);
        expect(view.steps).toEqual(['s1', 's2', lastStep]);
        expect(view.stepName).toBe('s2');
        expect(view.status).toBe(status);
        expect(view.runHold).toEqual({ hold: 'not-held' });
        expect(readRunBinding(wt)).toEqual(binding);
        expect(unchanged()).toEqual(before);
      });
    }
  }

  it('a symlinked record is replaced, never written through: the link target is untouched', () => {
    const { wt, recovery } = rig();
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    const outside = join(fx.outsideDir('a3-resume-link-target'), 'record.yaml');
    writeFileSync(outside, 'outside content\n');
    fx.plantRunRecordSymlink(wt, outside);

    expect(recovery.rebind(wt, { origin: 'global', id: 'resume-flow' }, 'refuse')).toEqual({ ok: true, outcome: 'resumed' });

    expect(readFileSync(outside, 'utf8')).toBe('outside content\n');
    expect(readRunBinding(wt)).toEqual({ source: 'catalog', tier: 'global', id: 'resume-flow' });
  });

  it('AC15: after a resume onto a catalog flow, a relaunch shows it despite a changed pointer and an added local flow.yaml', () => {
    const { wt, recovery, manager } = rig({ local: false });
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);
    expect(recovery.rebind(wt, { origin: 'global', id: 'resume-flow' }, 'refuse')).toEqual({ ok: true, outcome: 'resumed' });

    writeActiveFlow(wt, 'repo-flow');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['s1', 's2', 'local-3'] });

    expect(manager().state(wt).steps).toEqual(['s1', 's2', 'global-3']);
  });

  it('AC15: after a resume onto the global fallback, a relaunch shows it despite a changed pointer and an added local flow.yaml', () => {
    const { wt, recovery, manager } = rig({ local: false });
    fx.writeFlowState(wt, { step: 's2', status: 'done' });
    fx.writeRunRecordRaw(wt, '[unterminated flow sequence');
    expect(recovery.rebind(wt, { origin: 'fallback' }, 'refuse')).toEqual({ ok: true, outcome: 'resumed' });

    writeActiveFlow(wt, 'resume-flow');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['s1', 's2', 'local-3'] });

    const view = manager().state(wt);
    expect(view.steps).toEqual(['s1', 's2', 'fallback-3']);
    expect(view.status).toBe('done');
  });

  it('a global entry shadowed by a repo entry of the same id can be resumed onto, and the run keeps the global one', () => {
    const { home, wt, recovery, manager } = rig();
    catalog.addEntryWithSteps(flowCatalogDir(home), 'shared-flow', ['s1', 's2', 'global-shared-3']);
    catalog.addEntryWithSteps(flowCatalogDir(wt), 'shared-flow', ['s1', 's2', 'repo-shared-3']);
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);

    expect(recovery.rebind(wt, { origin: 'global', id: 'shared-flow' }, 'refuse')).toEqual({ ok: true, outcome: 'resumed' });

    expect(manager().state(wt).steps).toEqual(['s1', 's2', 'global-shared-3']);
    expect(createFlowManager({ globalDir: home, loadDefinition: (k) => createRunResolver(home, repoOnlyDefTiers())(k) }).state(wt).steps).toEqual([
      's1',
      's2',
      'global-shared-3',
    ]);
  });

  it('a hostile held step resumes onto a flow containing the raw step id', () => {
    const { home, wt, recovery, manager } = rig();
    const hostile = `s‮​x${'y'.repeat(MAX_ECHOED_REASON_LENGTH * 2)}`;
    catalog.addEntryWithSteps(flowCatalogDir(home), 'hostile-flow', ['s1', hostile, 'after']);
    fx.writeFlowState(wt, { step: hostile, status: 'in_progress' });
    fx.removeRunRecord(wt);

    expect(recovery.rebind(wt, { origin: 'global', id: 'hostile-flow' }, 'refuse')).toEqual({ ok: true, outcome: 'resumed' });

    const view = manager().state(wt);
    expect(view.stepName).toBe(hostile);
    expect(view.status).toBe('in_progress');
  });

  it('after a resume, a later Terminate shows the pre-run selection', () => {
    const { home, wt, recovery, manager } = rig();
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);
    expect(recovery.rebind(wt, { origin: 'global', id: 'resume-flow' }, 'refuse')).toEqual({ ok: true, outcome: 'resumed' });

    expect(manager().terminate(wt).outcome).toBe('reset');

    expect(readActiveFlow(wt)).toEqual({ kind: 'value', id: 'no-s2-flow' });
    expect(listCatalog({ worktreeDir: wt, globalRoot: home }).selection).toEqual({ kind: 'value', id: 'no-s2-flow' });
  });

  it.each([
    ['a local choice with no local flow.yaml', { local: false }, { origin: 'local' } as RebindChoice, /no flow\.yaml of its own/i],
    ['a fallback choice with no global fallback', { fallback: false }, { origin: 'fallback' } as RebindChoice, /could not be loaded/i],
    ['a catalog choice that is not in its tier', {}, { origin: 'repo', id: 'resume-flow' } as RebindChoice, /could not be loaded/i],
  ])('%s is refused, nothing is written, and the run stays held', (_label, opts, choice, reason) => {
    const { wt, recovery, unchanged } = rig(opts);
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);
    const before = unchanged();

    expect(expectCleanReason(recovery.rebind(wt, choice, 'refuse'))).toMatch(reason);

    expect(unchanged()).toEqual(before);
    expect(existsSync(join(flowHomeDir(wt), 'run-disposition.yaml'))).toBe(false);
    expect(heldRunOf(wt).hold).toBe('record-missing');
  });

  it("a chosen flow that fails to load is refused with its load error, display-safe and bounded", () => {
    const { home, wt, recovery, unchanged } = rig();
    const broken = join(flowCatalogDir(home), 'broken-flow');
    catalog.addEntryWithSteps(flowCatalogDir(home), 'broken-flow', ['s1']);
    writeFileSync(join(broken, FLOW_DEF_FILE), `name: broken\nsteps:\n  - id: "b‮​${'z'.repeat(MAX_ECHOED_REASON_LENGTH * 2)}"\n    kind: bogus\n`);
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);
    const before = unchanged();

    expect(expectCleanReason(recovery.rebind(wt, { origin: 'global', id: 'broken-flow' }, 'refuse'))).toMatch(/could not be loaded: flow\.yaml step "b/);

    expect(unchanged()).toEqual(before);
    expect(heldRunOf(wt).hold).toBe('record-missing');
  });

  it.skipIf(asRoot)('a record write that fails is refused with its reason, the step and selection are unchanged, and the run stays held', () => {
    const { home, wt, lockRoot, unchanged } = rig();
    const recovery = recoveryModule.createHeldRunRecovery({
      ...realDeps(home),
      lock: createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' }),
    });
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);
    const before = unchanged();

    chmodSync(flowHomeDir(wt), 0o555);
    let result: RebindResult;
    try {
      result = recovery.rebind(wt, { origin: 'global', id: 'resume-flow' }, 'refuse');
    } finally {
      chmodSync(flowHomeDir(wt), 0o755);
    }

    expect(expectCleanReason(result)).toMatch(/could not be recovered onto the chosen flow/i);
    expect(unchanged()).toEqual(before);
    expect(heldRunOf(wt)).toMatchObject({ hold: 'record-missing', step: 's2', status: 'in_progress' });
    expect(existsSync(join(flowHomeDir(wt), 'run-disposition.yaml'))).toBe(false);
  });

  it.each(RECORDS.filter(([record]) => record !== 'missing'))(
    'record %s: a record write that fails after the old record is cleared is refused, and the run stays held as record-missing',
    (_record, damage) => {
      const { home, wt, lockRoot, unchanged } = rig();
      const rebindRecordThatFails = (worktree: string): void => {
        clearDisposition(worktree);
        throw new Error('disk full');
      };
      const recovery = recoveryModule.createHeldRunRecovery({
        ...realDeps(home),
        lock: createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' }),
        rebindRecord: rebindRecordThatFails,
      });
      fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
      damage(wt);
      const before = unchanged();

      expect(expectCleanReason(recovery.rebind(wt, { origin: 'global', id: 'resume-flow' }, 'refuse'))).toMatch(/disk full/);

      expect(unchanged()).toEqual(before);
      expect(heldRunOf(wt)).toMatchObject({ hold: 'record-missing', step: 's2', status: 'in_progress' });
    },
  );

  it('the resume write happens while the rebind holds the worktree lock: a live peer is refused as held at that moment', () => {
    const { home, wt, lockRoot } = rig();
    const deps = realDeps(home);
    const probe = tryPeerLockDuring(lockRoot, wt);
    const recovery = recoveryModule.createHeldRunRecovery({
      ...deps,
      lock: createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' }),
      rebindRecord: probe.wrap(deps.rebindRecord),
    });
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);

    expect(recovery.rebind(wt, { origin: 'global', id: 'resume-flow' }, 'refuse')).toEqual({ ok: true, outcome: 'resumed' });

    expect(probe.observed()).not.toHaveLength(0);
    for (const attempt of probe.observed()) expect(attempt).toMatchObject({ ok: false, cause: 'held' });
  });

  it.each([
    ['a deleted lock root', (lockRoot: string) => rmSync(lockRoot, { recursive: true, force: true })],
    ['a deleted app home', (lockRoot: string) => rmSync(dirname(lockRoot), { recursive: true, force: true })],
  ] as const)('with %s the lock is rebuilt and really held while the resume is written', (_label, remove) => {
    const { home, wt, lockRoot } = rig();
    const deps = realDeps(home);
    const probe = tryPeerLockDuring(lockRoot, wt);
    const recovery = recoveryModule.createHeldRunRecovery({
      ...deps,
      lock: createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' }),
      rebindRecord: probe.wrap(deps.rebindRecord),
    });
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);
    mkdirSync(lockRoot, { recursive: true });
    remove(lockRoot);

    expect(recovery.rebind(wt, { origin: 'global', id: 'resume-flow' }, 'refuse')).toEqual({ ok: true, outcome: 'resumed' });

    expect(probe.observed()).not.toHaveLength(0);
    for (const attempt of probe.observed()) expect(attempt).toMatchObject({ ok: false, cause: 'held' });
    expect(readRunBinding(wt)).toEqual({ source: 'catalog', tier: 'global', id: 'resume-flow' });
  });

  it('a lock whose holder cannot be identified refuses the resume and nothing is written', () => {
    const { wt, lockRoot, recovery, unchanged } = rig({
      lock: (root) => createWorktreeLock({ lockRoot: root, holderLiveness: () => 'unreadable' }),
    });
    const lockFile = worktreeLockFile(lockRoot, wt);
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);
    const peer = createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' }).acquire(wt);
    expect(peer.ok).toBe(true);
    const planted = readFileSync(lockFile, 'utf8');
    const before = unchanged();

    const reason = expectCleanReason(recovery.rebind(wt, { origin: 'global', id: 'resume-flow' }, 'refuse'), MAX_ECHOED_LOCK_REASON_LENGTH);

    expectsUnidentifiedHolderRemedy(reason, lockFile);
    expect(unchanged()).toEqual(before);
    expect(heldRunOf(wt).hold).toBe('record-missing');
    expect(readFileSync(lockFile, 'utf8')).toBe(planted);
    if (peer.ok) peer.release();
  });

  it('T6c: an unusable lock directory does not block a resume, and the file in its place is left as found', () => {
    const { wt, lockRoot, recovery } = rig();
    writeFileSync(lockRoot, 'not a lock directory\n');
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);

    expect(recovery.rebind(wt, { origin: 'global', id: 'resume-flow' }, 'refuse')).toEqual({ ok: true, outcome: 'resumed' });

    expect(readRunBinding(wt)).toEqual({ source: 'catalog', tier: 'global', id: 'resume-flow' });
    expect(lstatSync(lockRoot).isFile()).toBe(true);
    expect(readFileSync(lockRoot, 'utf8')).toBe('not a lock directory\n');
  });

  it('a live peer holding the worktree lock refuses the resume and nothing is written', () => {
    const { wt, lockRoot, recovery, unchanged } = rig();
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);
    const lockFile = worktreeLockFile(lockRoot, wt);
    createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' }).acquire(wt);
    writeFileSync(lockFile, serializeLockHolder(currentLockHolder()));
    const before = unchanged();

    expectCleanReason(recovery.rebind(wt, { origin: 'global', id: 'resume-flow' }, 'refuse'));

    expect(unchanged()).toEqual(before);
    expect(existsSync(join(flowHomeDir(wt), 'run-disposition.yaml'))).toBe(false);
  });
});
