import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { createCatalogFixture } from '../helpers/catalogFixture';
import { tryPeerLockDuring } from '../helpers/lockDevices';
import { createFlowManager, flowCatalogDir, flowHomeDir } from '../../src/main/flow';
import { activeFlowPointerFile, readActiveFlow, writeActiveFlow } from '../../src/main/activeFlowPointer';
import { runDispositionFile } from '../../src/main/runDisposition';
import { createRunResolver } from '../../src/main/runResolver';
import { createWorktreeLock, currentLockHolder, serializeLockHolder, worktreeLockFile } from '../../src/main/worktreeLock';
import { createHeldRunRecovery, type HeldRunRecoveryDeps } from '../../src/main/heldRunRecovery';
import { productionRecoveryDeps } from '../helpers/heldRunRecoveryDeps';
import { heldRunOf } from '../../src/main/runHoldRead';
import { createFlowStateStore } from '../../src/main/flowState';
import { MAX_ECHOED_REASON_LENGTH } from '../../src/shared/controlChars';
import type { RebindChoice, RebindResult } from '../../src/shared/ipc';
import { repoOnlyDefTiers } from '../helpers/defTiers';
import { FLOW_DEF_FILE } from '../../src/main/flowHome';

// A3 (#134) §18.7.3 / §18.7.4 AC12 / AC13 — recovering a held run onto a flow that lacks its current step ends the
// run as a Terminate ends it, then makes the operator's choice the selection inside the same lock scope: a catalog
// choice is written to the pointer (it wins over a local flow.yaml), a local or fallback choice clears it
// (operator decision 2026-09-25). Real files, the production flow manager, the production gate body.

const asRoot = process.getuid?.() === 0;

const bytes = (file: string): string | null => (existsSync(file) ? readFileSync(file).toString('base64') : null);

describe('recovering a held run onto a flow lacking its step ends the run and selects the choice (AC12, AC13)', () => {
  const fx = createWorktreeFixture();
  const catalog = createCatalogFixture();
  afterEach(() => {
    fx.cleanup();
    catalog.cleanup();
  });

  function rig(opts: { local?: boolean; deps?: (real: Omit<HeldRunRecoveryDeps, 'lock'>, lockRoot: string, wt: string) => Partial<HeldRunRecoveryDeps> } = {}) {
    const home = fx.makeWorktree('a3-nomatch-home');
    const lockRoot = join(fx.outsideDir('a3-nomatch-locks'), 'locks');
    catalog.addEntryWithSteps(flowCatalogDir(home), 'prior-flow', ['s1', 's2', 'prior-3']);
    catalog.addEntryWithSteps(flowCatalogDir(home), 'no-s2-flow', ['x1', 'x2']);
    fx.writeFlowHome(home, { name: 'global-fallback', stepIds: ['f1', 'f2'] });
    const wt = fx.makeWorktree('a3-nomatch-wt');
    if (opts.local !== false) fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['l1', 'l2'] });
    writeActiveFlow(wt, 'prior-flow');
    const manager = () => createFlowManager({ globalDir: home, loadDefinition: (repoKey) => createRunResolver(home, repoOnlyDefTiers())(repoKey) });
    const real = productionRecoveryDeps(home);
    const recovery = createHeldRunRecovery({
      lock: createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' }),
      ...real,
      ...opts.deps?.(real, lockRoot, wt),
    });
    const progressionFile = join(flowHomeDir(wt), 'flow-state.yaml');
    const files = () => [bytes(progressionFile), bytes(runDispositionFile(wt)), bytes(activeFlowPointerFile(wt))];
    return { home, wt, lockRoot, recovery, manager, files };
  }

  const expectEnded = (wt: string, manager: () => ReturnType<typeof createFlowManager>): void => {
    const view = manager().state(wt);
    expect(view.status).toBe('not_started');
    expect(view.runStarted).toBe('never-started');
    expect(view.runHold).toEqual({ hold: 'not-held' });
    expect(existsSync(runDispositionFile(wt))).toBe(false);
  };

  const STATUSES: ('in_progress' | 'done')[] = ['in_progress', 'done'];
  const RECORDS: [string, (wt: string) => void][] = [
    ['missing', (wt) => fx.removeRunRecord(wt)],
    ['garbage YAML', (wt) => fx.writeRunRecordRaw(wt, '[unterminated flow sequence')],
    ['a symlink', (wt) => {
      const outside = join(fx.outsideDir('a3-nomatch-record-target'), 'record.yaml');
      writeFileSync(outside, 'schema_version: 1\nsource: non-catalog\n');
      fx.plantRunRecordSymlink(wt, outside);
    }],
    ['a directory', (wt) => fx.plantRunRecordDirectory(wt)],
  ];

  for (const [record, damage] of RECORDS) {
    it.each(STATUSES)(`record ${record}, %s: a catalog choice lacking the step ends the run and becomes the selection, over a local flow.yaml`, (status) => {
      const { wt, recovery, manager } = rig();
      fx.writeFlowState(wt, { step: 's2', status });
      damage(wt);

      expect(recovery.rebind(wt, { origin: 'global', id: 'no-s2-flow' }, { endRunHeldAt: 's2' })).toMatchObject({ ok: true, outcome: 'terminated' });

      expectEnded(wt, manager);
      expect(readActiveFlow(wt)).toEqual({ kind: 'value', id: 'no-s2-flow' });
      expect(manager().state(wt).steps).toEqual(['x1', 'x2']);
      const started = manager().start(wt);
      expect(started.status).toBe('in_progress');
      expect(started.stepName).toBe('x1');
    });
  }

  it('a symlinked record on the no-match path is removed, never followed: the link target is untouched', () => {
    const { wt, recovery, manager } = rig();
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    const outside = join(fx.outsideDir('a3-nomatch-link-target'), 'record.yaml');
    writeFileSync(outside, 'outside content\n');
    fx.plantRunRecordSymlink(wt, outside);

    expect(recovery.rebind(wt, { origin: 'global', id: 'no-s2-flow' }, { endRunHeldAt: 's2' })).toMatchObject({ ok: true, outcome: 'terminated' });

    expectEnded(wt, manager);
    expect(readFileSync(outside, 'utf8')).toBe('outside content\n');
    expect(() => lstatSync(runDispositionFile(wt))).toThrow(/ENOENT/);
  });

  it('a repo catalog choice lacking the step ends the run and becomes the selection, so the next Start runs it over a local flow.yaml', () => {
    const { wt, recovery, manager } = rig();
    catalog.addEntryWithSteps(flowCatalogDir(wt), 'repo-no-s2', ['r1', 'r2']);
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);

    expect(recovery.rebind(wt, { origin: 'repo', id: 'repo-no-s2' }, { endRunHeldAt: 's2' })).toMatchObject({ ok: true, outcome: 'terminated' });

    expectEnded(wt, manager);
    expect(readActiveFlow(wt)).toEqual({ kind: 'value', id: 'repo-no-s2' });
    const started = manager().start(wt);
    expect(started.steps).toEqual(['r1', 'r2']);
    expect(started.stepName).toBe('r1');
  });

  it('a fallback choice lacking the step, with a local flow.yaml present, ends the run and clears the selection, so the next Start runs the local flow', () => {
    const { wt, recovery, manager } = rig();
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);

    expect(recovery.rebind(wt, { origin: 'fallback' }, { endRunHeldAt: 's2' })).toMatchObject({ ok: true, outcome: 'terminated' });

    expectEnded(wt, manager);
    expect(existsSync(activeFlowPointerFile(wt))).toBe(false);
    const started = manager().start(wt);
    expect(started.steps).toEqual(['l1', 'l2']);
    expect(started.stepName).toBe('l1');
  });

  it.each(RECORDS)('record %s: a local choice lacking the step ends the run and clears the selection, so the next Start runs the local flow', (_record, damage) => {
    const { wt, recovery, manager } = rig();
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    damage(wt);

    expect(recovery.rebind(wt, { origin: 'local' }, { endRunHeldAt: 's2' })).toMatchObject({ ok: true, outcome: 'terminated' });

    expectEnded(wt, manager);
    expect(existsSync(activeFlowPointerFile(wt))).toBe(false);
    const started = manager().start(wt);
    expect(started.steps).toEqual(['l1', 'l2']);
    expect(started.stepName).toBe('l1');
  });

  it.each(RECORDS)('record %s: a fallback choice lacking the step, with no local flow.yaml, ends the run and clears the selection, so the next Start runs the global fallback', (_record, damage) => {
    const { wt, recovery, manager } = rig({ local: false });
    fx.writeFlowState(wt, { step: 's2', status: 'done' });
    damage(wt);

    expect(recovery.rebind(wt, { origin: 'fallback' }, { endRunHeldAt: 's2' })).toMatchObject({ ok: true, outcome: 'terminated' });

    expectEnded(wt, manager);
    expect(existsSync(activeFlowPointerFile(wt))).toBe(false);
    const started = manager().start(wt);
    expect(started.steps).toEqual(['f1', 'f2']);
    expect(started.stepName).toBe('f1');
  });

  it.each<[string, RebindChoice]>([
    ['a catalog choice', { origin: 'global', id: 'no-s2-flow' }],
    ['a local choice', { origin: 'local' }],
  ])('%s lacking the step ends the run without carrying its resolved inputs or loop-back counts into the next run', (_label, choice) => {
    const { wt, recovery } = rig();
    fx.writeFlowStateRaw(wt, 'step: s2\nstatus: in_progress\ninputs:\n  ticket: "176"\nrepeat_counts:\n  s2: 2\n');
    fx.removeRunRecord(wt);
    expect(createFlowStateStore(wt).read()).toMatchObject({ inputs: { ticket: '176' }, repeatCounts: { s2: 2 } });

    expect(recovery.rebind(wt, choice, { endRunHeldAt: 's2' })).toMatchObject({ ok: true, outcome: 'terminated' });

    const ended = createFlowStateStore(wt).read();
    expect(ended?.inputs).toBeUndefined();
    expect(ended?.repeatCounts).toBeUndefined();
  });

  it('a hostile held step that the chosen flow lacks ends the run on consent naming the step the flow view shows', () => {
    const { wt, recovery, manager } = rig();
    const hostile = `s‮​x${'y'.repeat(MAX_ECHOED_REASON_LENGTH * 2)}`;
    fx.writeFlowState(wt, { step: hostile, status: 'in_progress' });
    fx.removeRunRecord(wt);
    const shown = manager().state(wt).runHold;
    if (shown === undefined || shown.hold === 'not-held') throw new Error('the flow view does not show the run as held');

    expect(recovery.rebind(wt, { origin: 'global', id: 'no-s2-flow' }, { endRunHeldAt: shown.step })).toMatchObject({
      ok: true,
      outcome: 'terminated',
    });

    expectEnded(wt, manager);
    expect(readActiveFlow(wt)).toEqual({ kind: 'value', id: 'no-s2-flow' });
  });

  it('a held step made only of joiners, which the flow view shows as empty, ends the run on consent naming that empty copy', () => {
    const { wt, recovery, manager } = rig();
    fx.writeFlowState(wt, { step: '‍‌', status: 'in_progress' });
    fx.removeRunRecord(wt);
    const shown = manager().state(wt).runHold;
    if (shown === undefined || shown.hold === 'not-held') throw new Error('the flow view does not show the run as held');
    expect(shown.step).toBe('');

    expect(recovery.rebind(wt, { origin: 'global', id: 'no-s2-flow' }, { endRunHeldAt: shown.step })).toMatchObject({
      ok: true,
      outcome: 'terminated',
    });

    expectEnded(wt, manager);
    expect(readActiveFlow(wt)).toEqual({ kind: 'value', id: 'no-s2-flow' });
  });

  it.each<RebindChoice>([{ origin: 'global', id: 'no-s2-flow' }, { origin: 'local' }, { origin: 'fallback' }])(
    'an unconfirmed choice lacking the step is refused, saying it would end the run, and changes nothing (AC20): %o',
    (choice) => {
      const { wt, recovery, files } = rig();
      fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
      fx.removeRunRecord(wt);
      const before = files();

      const result: RebindResult = recovery.rebind(wt, choice, 'refuse');

      expect(result.ok).toBe(false);
      const reason = result.ok ? '' : result.reason;
      expect(reason).toMatch(/ends? the run/i);
      expect(reason).toContain('s2');
      expect(reason.length).toBeLessThanOrEqual(MAX_ECHOED_REASON_LENGTH);
      expect(files()).toEqual(before);
      expect(heldRunOf(wt)).toMatchObject({ hold: 'record-missing', step: 's2', status: 'in_progress' });
    },
  );

  it('a confirmed choice that contains the step resumes the run rather than ending it (AC20)', () => {
    const { wt, recovery } = rig();
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);

    expect(recovery.rebind(wt, { origin: 'global', id: 'prior-flow' }, { endRunHeldAt: 's2' })).toEqual({ ok: true, outcome: 'resumed' });
    expect(heldRunOf(wt)).toEqual({ hold: 'not-held' });
  });

  it('names, per offered choice, whether it resumes the held run, ends it, or cannot be chosen and why (AC19)', () => {
    const { home, wt, recovery, files } = rig();
    catalog.addEntryWithSteps(flowCatalogDir(wt), 'repo-with-s2', ['s1', 's2']);
    catalog.addEntryWithSteps(flowCatalogDir(home), 'broken-flow', ['s2']);
    writeFileSync(join(flowCatalogDir(home), 'broken-flow', FLOW_DEF_FILE), 'name: broken\nsteps:\n  - id: s2\n    kind: bogus\n');
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);
    const before = files();

    const outcomes = recovery.outcomes(wt, [
      { origin: 'local' },
      { origin: 'repo', id: 'repo-with-s2' },
      { origin: 'global', id: 'prior-flow' },
      { origin: 'global', id: 'no-s2-flow' },
      { origin: 'global', id: 'broken-flow' },
      { origin: 'fallback' },
    ]);

    expect(outcomes).toEqual([
      { choice: { origin: 'local' }, outcome: 'ends' },
      { choice: { origin: 'repo', id: 'repo-with-s2' }, outcome: 'resumes' },
      { choice: { origin: 'global', id: 'prior-flow' }, outcome: 'resumes' },
      { choice: { origin: 'global', id: 'no-s2-flow' }, outcome: 'ends' },
      { choice: { origin: 'global', id: 'broken-flow' }, outcome: 'unavailable', reason: expect.stringMatching(/could not be loaded/) },
      { choice: { origin: 'fallback' }, outcome: 'ends' },
    ]);
    expect(files()).toEqual(before);
  });

  it.each<[string, (home: string, wt: string) => void, string, RegExp]>([
    [
      'shadowed by a repo entry of the same id',
      (home, wt) => {
        catalog.addEntryWithSteps(flowCatalogDir(home), 'shared-flow', ['g1', 'g2']);
        catalog.addEntryWithSteps(flowCatalogDir(wt), 'shared-flow', ['r1', 'r2']);
      },
      'shared-flow',
      /would be selected instead/,
    ],
    [
      'whose repo entry of the same id is refused',
      (_home, wt) => {
        catalog.addEntryWithSteps(flowCatalogDir(wt), 'no-s2-flow', ['r1', 'r2']);
        catalog.symlinkEntryFlowYaml(flowCatalogDir(wt), 'no-s2-flow');
      },
      'no-s2-flow',
      /cannot be selected/,
    ],
  ])('a global choice %s is never labelled as ending the run, since the recovery refuses it (AC19)', (_label, plant, id, reason) => {
    const { home, wt, recovery } = rig();
    plant(home, wt);
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);
    const choice: RebindChoice = { origin: 'global', id };

    expect(recovery.outcomes(wt, [choice])).toEqual([{ choice, outcome: 'unavailable', reason: expect.stringMatching(reason) }]);
    const refused = recovery.rebind(wt, choice, 'refuse');
    expect(refused.ok ? '' : refused.reason, 'the refusal an unconfirmed choice gets is the same one, not a request to confirm').toMatch(reason);
  });

  it("a choice whose flow cannot be loaded is listed unavailable with the load error display-safe and bounded (§18.7.6)", () => {
    const hostile = `‮${'x'.repeat(500)}\u0007`;
    const { wt, recovery } = rig({ deps: () => ({ loadBound: () => ({ ok: false, error: hostile }) }) });
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);

    const [listed] = recovery.outcomes(wt, [{ origin: 'global', id: 'prior-flow' }]);

    expect(listed).toMatchObject({ outcome: 'unavailable', reason: expect.stringMatching(/could not be loaded/) });
    const reason = listed?.outcome === 'unavailable' ? listed.reason : '';
    expect(reason).not.toMatch(/[‮\u0000-\u001F]/);
    expect(reason.length).toBeLessThanOrEqual(MAX_ECHOED_REASON_LENGTH);
  });

  it('a confirmation to end the run held at one step never ends a run now held at another (§6)', () => {
    const { wt, recovery, files } = rig();
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);
    fx.writeFlowState(wt, { step: 'prior-3', status: 'in_progress' });
    const before = files();

    const result: RebindResult = recovery.rebind(wt, { origin: 'global', id: 'no-s2-flow' }, { endRunHeldAt: 's2' });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(/changed/i);
    expect(files()).toEqual(before);
    expect(heldRunOf(wt)).toMatchObject({ hold: 'record-missing', step: 'prior-3' });
  });

  it('names no outcome for a worktree that is not held', () => {
    const { wt, recovery } = rig();

    expect(recovery.outcomes(wt, [{ origin: 'global', id: 'prior-flow' }, { origin: 'fallback' }])).toEqual([]);
  });

  it('a global choice shadowed by a repo entry of the same id is refused before the run is ended, since the pointer would name the repo one', () => {
    const { home, wt, recovery, files } = rig();
    catalog.addEntryWithSteps(flowCatalogDir(home), 'shared-flow', ['g1', 'g2']);
    catalog.addEntryWithSteps(flowCatalogDir(wt), 'shared-flow', ['r1', 'r2']);
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);
    const before = files();

    const result: RebindResult = recovery.rebind(wt, { origin: 'global', id: 'shared-flow' }, { endRunHeldAt: 's2' });

    expect(result.ok ? '' : result.reason).toMatch(/repo/i);
    expect(result.ok ? '' : result.reason).not.toMatch(/current step/i);
    expect(files()).toEqual(before);
    expect(heldRunOf(wt)).toMatchObject({ hold: 'record-missing', step: 's2', status: 'in_progress' });
  });

  it('a global choice whose repo tier refuses the same id is refused before the run is ended, since the tier-less resolve the pointer takes fails', () => {
    const { wt, recovery, files } = rig();
    catalog.addEntryWithSteps(flowCatalogDir(wt), 'no-s2-flow', ['r1', 'r2']);
    catalog.symlinkEntryFlowYaml(flowCatalogDir(wt), 'no-s2-flow');
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);
    const before = files();

    const result: RebindResult = recovery.rebind(wt, { origin: 'global', id: 'no-s2-flow' }, { endRunHeldAt: 's2' });

    expect(result.ok ? '' : result.reason).toMatch(/no-s2-flow/);
    expect(result.ok ? '' : result.reason).not.toMatch(/current step/i);
    expect(result.ok ? '' : result.reason, 'the refused repo entry is not offered, so the reason must not send the operator to it').not.toMatch(
      /choose the repo entry|would be selected instead/i,
    );
    expect(files()).toEqual(before);
    expect(heldRunOf(wt)).toMatchObject({ hold: 'record-missing', step: 's2', status: 'in_progress' });
  });

  it.skipIf(asRoot)('a Terminate the manager refuses ends nothing: the rebind is refused and no file changes', () => {
    const { wt, recovery, files } = rig();
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);
    const before = files();

    chmodSync(flowHomeDir(wt), 0o555);
    let result: RebindResult;
    try {
      result = recovery.rebind(wt, { origin: 'global', id: 'no-s2-flow' }, { endRunHeldAt: 's2' });
    } finally {
      chmodSync(flowHomeDir(wt), 0o755);
    }

    expect(result.ok ? '' : result.reason).toMatch(/EACCES|permission/i);
    expect(result.ok ? '' : result.reason).not.toMatch(/current step/i);
    expect(files()).toEqual(before);
    expect(heldRunOf(wt).hold).toBe('record-missing');
  });

  it.skipIf(asRoot)("a reset whose run record survives reports the run ended with Terminate's notice, and the selection is left as it was", () => {
    const { wt, recovery, manager } = rig();
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    const record = runDispositionFile(wt);
    rmSync(record, { force: true });
    const stuck = join(record, 'locked');
    mkdirSync(stuck, { recursive: true });
    writeFileSync(join(stuck, 'f'), '');
    chmodSync(stuck, 0o555);
    const pointerBefore = bytes(activeFlowPointerFile(wt));
    let result: RebindResult;
    try {
      expect(heldRunOf(wt).hold).toBe('record-unreadable');
      result = recovery.rebind(wt, { origin: 'global', id: 'no-s2-flow' }, { endRunHeldAt: 's2' });
    } finally {
      chmodSync(stuck, 0o755);
    }

    expect(result).toMatchObject({ ok: true, outcome: 'terminated', notice: expect.stringMatching(/run record/) });
    expect(bytes(activeFlowPointerFile(wt))).toBe(pointerBefore);
    expect(manager().state(wt).status).toBe('not_started');
  });

  it('a selection write that fails after the reset still reports the run ended, with a notice naming the unsaved choice', () => {
    const { wt, recovery, manager } = rig();
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);
    fx.plantPointerDirectory(wt);

    const result = recovery.rebind(wt, { origin: 'global', id: 'no-s2-flow' }, { endRunHeldAt: 's2' });

    expect(result).toMatchObject({ ok: true, outcome: 'terminated', notice: expect.stringMatching(/could not be selected/) });
    expect(result.ok && result.outcome === 'terminated' ? result.notice : '').toMatch(/default flow is selected instead/);
    expect(readActiveFlow(wt)).toMatchObject({ kind: 'unset' });
    expect(existsSync(runDispositionFile(wt))).toBe(false);
    expect(heldRunOf(wt)).toEqual({ hold: 'not-held' });
    expect(manager().state(wt)).toMatchObject({ runStarted: 'never-started', status: 'not_started' });
  });

  it.skipIf(asRoot)('a selection write and its fallback clear that both fail after the reset never claim the default flow is selected', () => {
    const { wt, recovery } = rig();
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);
    const pointerDir = fx.plantPointerDirectory(wt);
    chmodSync(pointerDir, 0o555);
    let result: RebindResult;
    try {
      result = recovery.rebind(wt, { origin: 'global', id: 'no-s2-flow' }, { endRunHeldAt: 's2' });
    } finally {
      chmodSync(pointerDir, 0o755);
    }

    expect(result).toMatchObject({ ok: true, outcome: 'terminated', notice: expect.stringMatching(/could not be selected/) });
    expect(result.ok && result.outcome === 'terminated' ? result.notice : '').not.toMatch(/default flow is selected/);
    expect(heldRunOf(wt)).toEqual({ hold: 'not-held' });
  });

  it.skipIf(asRoot)('a selection clear that fails after the reset still reports the run ended, with a notice naming the uncleared selection', () => {
    const { wt, recovery } = rig();
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);
    const pointerDir = fx.plantPointerDirectory(wt);
    chmodSync(pointerDir, 0o555);
    let result: RebindResult;
    try {
      result = recovery.rebind(wt, { origin: 'local' }, { endRunHeldAt: 's2' });
    } finally {
      chmodSync(pointerDir, 0o755);
    }

    expect(result).toMatchObject({ ok: true, outcome: 'terminated', notice: expect.stringMatching(/could not be cleared/) });
    expect(existsSync(runDispositionFile(wt))).toBe(false);
    expect(heldRunOf(wt)).toEqual({ hold: 'not-held' });
  });

  it.each([
    ['sets a catalog choice', { origin: 'global', id: 'no-s2-flow' } as RebindChoice],
    ['clears for a local choice', { origin: 'local' } as RebindChoice],
  ])('the selection write that %s happens while the rebind holds the worktree lock: a live peer is refused as held at that moment', (_label, choice) => {
    let probe: ReturnType<typeof tryPeerLockDuring> | undefined;
    const { wt, recovery } = rig({
      deps: (real, lockRoot, worktree) => {
        probe = tryPeerLockDuring(lockRoot, worktree);
        return { selectIfUnlocked: probe.wrap(real.selectIfUnlocked) };
      },
    });
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);

    expect(recovery.rebind(wt, choice, { endRunHeldAt: 's2' })).toMatchObject({ ok: true, outcome: 'terminated' });

    expect(probe?.observed()).not.toHaveLength(0);
    for (const attempt of probe?.observed() ?? []) expect(attempt).toMatchObject({ ok: false, cause: 'held' });
  });

  it('the Terminate that ends the run happens while the rebind holds the worktree lock: a live peer is refused as held at that moment', () => {
    let probe: ReturnType<typeof tryPeerLockDuring> | undefined;
    const { wt, recovery } = rig({
      deps: (real, lockRoot, worktree) => {
        probe = tryPeerLockDuring(lockRoot, worktree);
        return { terminate: probe.wrap(real.terminate) };
      },
    });
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);

    expect(recovery.rebind(wt, { origin: 'global', id: 'no-s2-flow' }, { endRunHeldAt: 's2' })).toMatchObject({ ok: true, outcome: 'terminated' });

    expect(probe?.observed()).not.toHaveLength(0);
    for (const attempt of probe?.observed() ?? []) expect(attempt).toMatchObject({ ok: false, cause: 'held' });
  });

  it.each([
    ['sets a catalog choice', { origin: 'global', id: 'no-s2-flow' } as RebindChoice, { kind: 'value', id: 'no-s2-flow' }, ['x1', 'x2']],
    ['clears for a local choice', { origin: 'local' } as RebindChoice, { kind: 'unset' }, ['l1', 'l2']],
  ])("the Terminate and the selection write that %s happen in one worktree-lock scope: a peer Start the moment the lock is first released runs the operator's choice", (_label, choice, selection, steps) => {
    let peerStart: (() => void) | undefined;
    const { wt, recovery, manager } = rig({
      deps: (_real, lockRoot) => {
        const lock = createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' });
        return {
          lock: {
            withWorktreeLock: <T>(worktree: string, fn: Parameters<typeof lock.withWorktreeLock<T>>[1]) => {
              const result = lock.withWorktreeLock(worktree, fn);
              peerStart?.();
              return result;
            },
          },
        };
      },
    });
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);
    let started: ReturnType<ReturnType<typeof manager>['start']> | undefined;
    peerStart = () => {
      started ??= manager().start(wt);
    };

    recovery.rebind(wt, choice, { endRunHeldAt: 's2' });

    expect(readActiveFlow(wt)).toEqual(selection);
    expect(started?.steps).toEqual(steps);
    expect(started?.stepName).toBe(steps[0]);
  });

  it('a live peer holding the worktree lock refuses a no-match rebind and nothing is written', () => {
    const { wt, lockRoot, recovery, files } = rig();
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);
    const lockFile = worktreeLockFile(lockRoot, wt);
    createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' }).acquire(wt);
    writeFileSync(lockFile, serializeLockHolder(currentLockHolder()));
    const before = files();

    const result: RebindResult = recovery.rebind(wt, { origin: 'global', id: 'no-s2-flow' }, { endRunHeldAt: 's2' });

    expect(result.ok ? '' : result.reason).toMatch(/another agent terminal window/i);
    expect(result.ok ? '' : result.reason).not.toMatch(/current step/i);
    expect(files()).toEqual(before);
    expect(heldRunOf(wt).hold).toBe('record-missing');
  });
});
