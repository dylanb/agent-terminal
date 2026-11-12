import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { createCatalogFixture } from '../helpers/catalogFixture';
import { createAuditRunFixture } from '../helpers/auditRun';
import { expectsUnidentifiedHolderRemedy, tryPeerLockDuring } from '../helpers/lockDevices';
import { createFlowManager, flowCatalogDir, flowHomeDir, type FlowManager } from '../../src/main/flow';
import { createRunResolver } from '../../src/main/runResolver';
import { createTodoStore } from '../../src/main/todoStore';
import { clearSliceBrief, readSliceBrief, writeSliceBrief } from '../../src/main/appLoopState';
import { readRunBinding, runDispositionFile } from '../../src/main/runDisposition';
import {
  createWorktreeLock,
  currentLockHolder,
  serializeLockHolder,
  worktreeLockFile,
  type WorktreeLock,
} from '../../src/main/worktreeLock';
import { createHeldRunRecovery, realHeldRunRecoveryDeps, type HeldRunRecoveryDeps } from '../../src/main/heldRunRecovery';
import * as gateModule from '../../src/main/activeFlowGate';
import { readActiveFlow } from '../../src/main/activeFlowPointer';
import { createFlowLifecycle } from '../../src/main/flowLifecycle';
import { createPendingNotices } from '../../src/main/pendingNotices';
import { heldRunOf } from '../../src/main/runHoldRead';
import type { FlowStateView } from '../../src/shared/ipc';
import { parseAuditStream } from '../../src/shared/audit';
import { MAX_ECHOED_REASON_LENGTH } from '../../src/shared/controlChars';

// A3 (#134) T6a / T6b — the flow lifecycle owns every Terminate's side effects and takes the worktree lock itself,
// so the UI route and the engine ports alike are refused while a live or unidentifiable peer holds it; a rebind's
// lifecycle effects run only for what the rebind actually did (§25 truthful-entry rule).

const HELD_TEXT = 'Another Agent Terminal window';
const asRoot = process.getuid?.() === 0;

const reasonOf = (result: object): string | undefined => ('reason' in result ? String(result.reason) : undefined);

function withReadOnlyFlowHome<T>(wt: string, act: () => T): T {
  chmodSync(flowHomeDir(wt), 0o555);
  try {
    return act();
  } finally {
    chmodSync(flowHomeDir(wt), 0o755);
  }
}

describe('the flow lifecycle (A3 T6a/T6b)', () => {
  const fx = createWorktreeFixture();
  const catalog = createCatalogFixture();
  afterEach(() => {
    fx.cleanup();
    catalog.cleanup();
  });

  function rig(opts: { lock?: (lockRoot: string) => WorktreeLock; wrapFlow?: (m: FlowManager) => Pick<FlowManager, 'terminate' | 'state' | 'revertStep'>; activeTurn?: boolean; worktreeName?: string; forgetThrows?: boolean } = {}) {
    const home = fx.makeWorktree('a3-lc-home');
    fx.writeFlowHome(home, { name: 'global-fallback', stepIds: ['s1', 's2'] });
    catalog.addEntryWithSteps(flowCatalogDir(home), 'resume-flow', ['s1', 's2', 's3']);
    catalog.addEntryWithSteps(flowCatalogDir(home), 'other-flow', ['o1', 'o2']);
    const wt = fx.makeWorktree(opts.worktreeName ?? 'a3-lc-wt');
    const lockRoot = join(fx.outsideDir('a3-lc-locks'), 'locks');
    const audit = createAuditRunFixture(fx.outsideDir('a3-lc-audit'), 'global-fallback');
    const manager = createFlowManager({ globalDir: home, loadDefinition: (k) => createRunResolver(home)(k) });
    const todos = createTodoStore({ maxDoneTodos: 10 });
    const notices = createPendingNotices();
    const effects = { monitorCleared: 0, flowChanged: 0, forgotten: [] as string[], released: [] as string[] };
    const lock = opts.lock?.(lockRoot) ?? createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' });
    const lifecycle = createFlowLifecycle({
      lock,
      flow: opts.wrapFlow?.(manager) ?? manager,
      recovery: createHeldRunRecovery({
        lock,
        ...({
          ...realHeldRunRecoveryDeps(home),
          terminate: (k: string) => manager.terminate(k),
          selectIfUnlocked: gateModule.selectIfUnlocked,
        } satisfies Omit<HeldRunRecoveryDeps, 'lock'>),
      }),
      pendingNotices: notices,
      loopTurnActive: (k: string) => opts.activeTurn === true && k === wt,
      forgetRunEntry: (k: string) => {
        effects.forgotten.push(k);
        if (opts.forgetThrows === true) throw new Error('the run registry is unwritable');
      },
      endRun: () => {},
      recordTerminate: (k: string) => audit.recorder.recordTerminate(k),
      recordRollback: (k, before, after) => audit.recorder.recordTransition(k, 'rollback', before, after),
      clearTodos: (k: string) => todos.clear(k),
      clearSliceBrief: (k: string) => clearSliceBrief(k),
      clearMonitor: () => effects.monitorCleared++,
      flowChanged: () => effects.flowChanged++,
      releaseLoopTurn: (k: string) => effects.released.push(k),
      presentView: (_k: string, v: FlowStateView): FlowStateView => ({ ...v, loopActivity: { kind: 'presented' } as unknown as FlowStateView['loopActivity'] }),
    });
    const begin = (): void => {
      const before = manager.state(wt);
      const after = manager.start(wt);
      expect(after.status).toBe('in_progress');
      audit.openRun(wt, before, after);
      todos.add(wt, 'a todo from the run');
    };
    const progression = (): string | null => {
      const f = join(flowHomeDir(wt), 'flow-state.yaml');
      return existsSync(f) ? readFileSync(f, 'utf8') : null;
    };
    const holdAsPeer = (): void => {
      const file = worktreeLockFile(lockRoot, wt);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, serializeLockHolder(currentLockHolder()));
    };
    const advance = (): void => {
      const before = manager.state(wt);
      audit.recorder.recordTransition(wt, 'advance', before, manager.advance(wt));
    };
    /** The run's lifecycle entries after its Start, as the §25 record holds them. */
    const lifecycleAfterStart = (): unknown[] =>
      parseAuditStream(readFileSync(audit.runFile(wt), 'utf8'))
        .events.filter((e) => e.type === 'step.entered' || e.type === 'flow.status')
        .map(({ ts: _ts, ...rest }) => rest);
    return { home, wt, lockRoot, audit, manager, todos, notices, effects, lifecycle, begin, advance, lifecycleAfterStart, progression, holdAsPeer };
  }

  const RECONSTRUCTIONS = [
    ['a deleted lock root', (lockRoot: string) => rmSync(lockRoot, { recursive: true, force: true })],
    ['a deleted app home', (lockRoot: string) => rmSync(dirname(lockRoot), { recursive: true, force: true })],
  ] as const;

  function probedRig() {
    let probe: ReturnType<typeof tryPeerLockDuring> | undefined;
    const r = rig({
      wrapFlow: (m) => ({
        ...m,
        terminate: (k: string) => {
          probe ??= tryPeerLockDuring(r.lockRoot, k);
          return probe.wrap(m.terminate)(k);
        },
      }),
    });
    return { ...r, probe: () => probe };
  }

  const presented = (view: FlowStateView): unknown => (view.loopActivity as unknown as { kind?: string } | undefined)?.kind;

  describe('terminate (the UI route)', () => {
    it('a begun run is reset: flow.terminated in the audit run, todos cleared, the back-to-RED brief cleared, the monitor cleared, and the strip told', () => {
      const { wt, audit, todos, effects, lifecycle, begin } = rig();
      begin();
      writeSliceBrief(wt, { slice: 1, fromStep: 's2', text: 'cover the empty input' });

      const result = lifecycle.terminate(wt);

      expect(result.outcome).toBe('reset');
      expect(result.view.status).toBe('not_started');
      expect(presented(result.view)).toBe('presented');
      expect(audit.eventTypes(wt)).toContain('flow.terminated');
      expect(todos.list(wt)).toEqual([]);
      expect(readSliceBrief(wt)).toBeNull();
      expect(effects.monitorCleared).toBe(1);
      expect(effects.flowChanged).toBeGreaterThan(0);
      expect(effects.forgotten).toEqual([wt]);
      expect(effects.released).toEqual([wt]);
    });

    it('a reset effect that throws aborts neither the reset nor the effects after it', () => {
      const { wt, audit, todos, effects, lifecycle, begin } = rig({ forgetThrows: true });
      begin();

      const result = lifecycle.terminate(wt);

      expect(result.outcome).toBe('reset');
      expect(audit.eventTypes(wt)).toContain('flow.terminated');
      expect(todos.list(wt)).toEqual([]);
      expect(effects.monitorCleared).toBe(1);
      expect(effects.flowChanged).toBeGreaterThan(0);
    });

    it('a never-started run is refused as not-begun, and none of the reset effects happen', () => {
      const { wt, audit, todos, effects, lifecycle, notices, manager } = rig();
      const before = manager.state(wt);
      audit.openRun(wt, before, { ...before, status: 'in_progress' });
      todos.add(wt, 'kept');
      writeSliceBrief(wt, { slice: 1, fromStep: 's2', text: 'kept brief' });

      const result = lifecycle.terminate(wt);

      expect(result).toMatchObject({ outcome: 'refused', cause: 'not-begun' });
      expect(readSliceBrief(wt)?.text).toBe('kept brief');
      expect(presented(result.view)).toBe('presented');
      expect(audit.eventTypes(wt)).not.toContain('flow.terminated');
      expect(todos.list(wt)).toHaveLength(1);
      expect(effects).toEqual({ monitorCleared: 0, flowChanged: 0, forgotten: [], released: [] });
      expect(notices.take(wt)).toBeUndefined();
    });

    it('is refused as locked while a live peer holds the worktree lock: nothing is written, the reason shows once on the reply, nothing is posted', () => {
      const { wt, audit, effects, lifecycle, notices, begin, progression, holdAsPeer } = rig();
      begin();
      holdAsPeer();
      const before = progression();

      const result = lifecycle.terminate(wt);

      expect(result).toMatchObject({ outcome: 'refused', cause: 'locked' });
      expect(reasonOf(result)).toContain(HELD_TEXT);
      expect(result.view.notice).toBe(reasonOf(result));
      expect(result.view.status).toBe('in_progress');
      expect(progression()).toBe(before);
      expect(audit.eventTypes(wt)).not.toContain('flow.terminated');
      expect(effects.monitorCleared).toBe(0);
      expect(notices.take(wt)).toBeUndefined();
    });

    it.skipIf(asRoot)('a begun run whose progression cannot be reset is refused as failed with a reason, and none of the reset effects happen', () => {
      const { wt, audit, todos, effects, lifecycle, notices, begin, progression } = rig();
      begin();
      const before = progression();

      const result = withReadOnlyFlowHome(wt, () => lifecycle.terminate(wt));

      expect(result).toMatchObject({ outcome: 'refused', cause: 'failed', reason: expect.stringMatching(/\S/) });
      expect(result.view.notice).toBe(reasonOf(result));
      expect(progression()).toBe(before);
      expect(audit.eventTypes(wt)).not.toContain('flow.terminated');
      expect(todos.list(wt)).toHaveLength(1);
      expect(effects).toEqual({ monitorCleared: 0, flowChanged: 0, forgotten: [], released: [] });
      expect(notices.take(wt)).toBeUndefined();
    });

    it('resets while holding the worktree lock: a live peer trying it at that moment is refused as held', () => {
      const r = probedRig();
      r.begin();

      expect(r.lifecycle.terminate(r.wt).outcome).toBe('reset');

      expect(r.probe()?.observed()).not.toHaveLength(0);
      for (const attempt of r.probe()?.observed() ?? []) expect(attempt).toMatchObject({ ok: false, cause: 'held' });
    });

    it('a lock whose holder cannot be identified refuses a Terminate, and the run stays begun', () => {
      const r = rig({ lock: (root) => createWorktreeLock({ lockRoot: root, holderLiveness: () => 'unreadable' }) });
      r.begin();
      r.holdAsPeer();
      const planted = readFileSync(worktreeLockFile(r.lockRoot, r.wt), 'utf8');
      const before = r.progression();

      const result = r.lifecycle.terminate(r.wt);

      expect(result).toMatchObject({ outcome: 'refused', cause: 'locked' });
      expectsUnidentifiedHolderRemedy(reasonOf(result) ?? '', worktreeLockFile(r.lockRoot, r.wt));
      expect(result.view.notice).toBe(reasonOf(result));
      expect(r.progression()).toBe(before);
      expect(r.audit.eventTypes(r.wt)).not.toContain('flow.terminated');
      expect(r.todos.list(r.wt)).not.toEqual([]);
      expect(r.notices.take(r.wt)).toBeUndefined();
      expect(readFileSync(worktreeLockFile(r.lockRoot, r.wt), 'utf8')).toBe(planted);
    });

    it('T6c: an unusable lock directory does not block a Terminate, and the file in its place is left as found', () => {
      const r = rig();
      r.begin();
      writeFileSync(r.lockRoot, 'not a lock directory\n');

      expect(r.lifecycle.terminate(r.wt).outcome).toBe('reset');

      expect(r.audit.eventTypes(r.wt)).toContain('flow.terminated');
      expect(r.notices.take(r.wt)).toBeUndefined();
      expect(readFileSync(r.lockRoot, 'utf8')).toBe('not a lock directory\n');
    });

    it.each(RECONSTRUCTIONS)('with %s the lock is rebuilt and really held while the run is reset', (_label, remove) => {
      const r = probedRig();
      r.begin();
      mkdirSync(r.lockRoot, { recursive: true });
      remove(r.lockRoot);

      expect(r.lifecycle.terminate(r.wt).outcome).toBe('reset');

      expect(r.probe()?.observed()).not.toHaveLength(0);
      for (const attempt of r.probe()?.observed() ?? []) expect(attempt).toMatchObject({ ok: false, cause: 'held' });
    });
  });

  describe('rollbackStep (a failed step bootstrap)', () => {
    it('a rollback to the previous step records that step as entered again in the run\'s audit record', () => {
      const r = rig();
      r.begin();
      r.advance();

      expect(r.lifecycle.rollbackStep(r.wt, 's2')).toMatchObject({ status: 'in_progress', stepName: 's1' });

      expect(r.lifecycleAfterStart()).toEqual([
        { type: 'step.entered', step: 's2' },
        { type: 'step.entered', step: 's1' },
      ]);
    });

    it('a first-step rollback records the run going back to never-started in its audit record', () => {
      const r = rig();
      r.begin();

      r.lifecycle.rollbackStep(r.wt, 's1');

      expect(r.lifecycleAfterStart()).toEqual([{ type: 'flow.status', from: 'in_progress', to: 'not_started' }]);
    });

    it('a rollback for a step the flow is no longer at changes nothing and records nothing', () => {
      const r = rig();
      r.begin();
      r.advance();

      expect(r.lifecycle.rollbackStep(r.wt, 's1')).toMatchObject({ status: 'in_progress', stepName: 's2' });

      expect(r.lifecycleAfterStart()).toEqual([{ type: 'step.entered', step: 's2' }]);
    });

    it('a first-step rollback resets the run to never-started while holding the worktree lock: a live peer trying it then is refused as held', () => {
      let probe: ReturnType<typeof tryPeerLockDuring> | undefined;
      const r = rig({
        wrapFlow: (m) => ({
          ...m,
          revertStep: (k: string, step: string) => {
            probe ??= tryPeerLockDuring(r.lockRoot, k);
            return probe.wrap(m.revertStep)(k, step);
          },
        }),
      });
      r.begin();

      const view = r.lifecycle.rollbackStep(r.wt, 's1');

      expect(view.status).toBe('not_started');
      expect(view.runStarted).toBe('never-started');
      expect(probe?.observed()).not.toHaveLength(0);
      for (const attempt of probe?.observed() ?? []) expect(attempt).toMatchObject({ ok: false, cause: 'held' });
    });

    it('is refused with the lock reason while a live peer holds the worktree lock, leaving the run begun, its record in place and nothing audited', () => {
      const { wt, lifecycle, begin, progression, holdAsPeer, manager, lifecycleAfterStart } = rig();
      begin();
      holdAsPeer();
      const before = progression();
      const record = readRunBinding(wt);

      expect(() => lifecycle.rollbackStep(wt, 's1')).toThrow(HELD_TEXT);
      expect(() => lifecycle.rollbackStep(wt, 's1'), 'nothing retries the rollback, so the reason names the way out').toThrow(
        /Terminate/,
      );

      expect(progression()).toBe(before);
      expect(readRunBinding(wt)).toEqual(record);
      expect(manager.state(wt)).toMatchObject({ status: 'in_progress', runStarted: 'started' });
      expect(lifecycleAfterStart()).toEqual([]);
    });

    it('a rollback whose run record cannot be removed names Terminate as the way out, since nothing retries it', () => {
      const r = rig({
        wrapFlow: (m) => ({
          ...m,
          revertStep: () => {
            throw new Error('the run record could not be removed: EACCES: permission denied');
          },
        }),
      });
      r.begin();

      expect(() => r.lifecycle.rollbackStep(r.wt, 's1')).toThrow(/could not be removed[^]*Terminate/);
    });

    it('a rollback that fails after removing the run record tells the strip, which now has a held run to show', () => {
      const r = rig({
        wrapFlow: (m) => ({
          ...m,
          revertStep: (k: string) => {
            rmSync(runDispositionFile(k), { force: true });
            throw new Error('revert failed; the run record could not be restored: EACCES: permission denied');
          },
        }),
      });
      r.begin();
      const before = r.effects.flowChanged;

      expect(() => r.lifecycle.rollbackStep(r.wt, 's1')).toThrow(/could not be restored/);

      expect(heldRunOf(r.wt)).toMatchObject({ hold: 'record-missing', step: 's1' });
      expect(r.effects.flowChanged).toBe(before + 1);
    });
  });

  describe('terminateUnattended (the engine ports)', () => {
    it('a refusal while a live peer holds the lock posts its reason for the next flow:state exactly once, and tells the strip', () => {
      const { wt, effects, lifecycle, notices, begin, progression, holdAsPeer } = rig();
      begin();
      holdAsPeer();
      const before = progression();

      const result = lifecycle.terminateUnattended(wt);

      expect(result).toMatchObject({ outcome: 'refused', cause: 'locked' });
      expect(progression()).toBe(before);
      expect(effects.flowChanged).toBeGreaterThan(0);
      expect(notices.take(wt)).toContain(HELD_TEXT);
      expect(notices.take(wt)).toBeUndefined();
    });

    it.skipIf(asRoot)('a failed refusal posts its reason exactly once for the next flow:state', () => {
      const { wt, effects, lifecycle, notices, begin } = rig();
      begin();

      const result = withReadOnlyFlowHome(wt, () => lifecycle.terminateUnattended(wt));

      expect(result).toMatchObject({ outcome: 'refused', cause: 'failed' });
      expect(effects.flowChanged).toBeGreaterThan(0);
      expect(notices.take(wt)).toBe(reasonOf(result));
      expect(notices.take(wt)).toBeUndefined();
    });

    it.skipIf(asRoot)('a failed refusal whose reason carries a hostile worktree path posts it display-safe and bounded', () => {
      const r = rig({ worktreeName: `a3-lc-wt‮${'x'.repeat(220)}` });
      r.begin();

      const result = withReadOnlyFlowHome(r.wt, () => r.lifecycle.terminateUnattended(r.wt));

      expect(result).toMatchObject({ outcome: 'refused', cause: 'failed' });
      const posted = r.notices.take(r.wt) ?? '';
      expect(posted).toMatch(/\S/);
      expect(posted).not.toMatch(/‮/u);
      expect(posted.length).toBeLessThanOrEqual(MAX_ECHOED_REASON_LENGTH);
      expect(reasonOf(result)).toBe(posted);
    });

    it('a not-begun refusal posts nothing', () => {
      const { wt, effects, lifecycle, notices } = rig();

      expect(lifecycle.terminateUnattended(wt)).toMatchObject({ outcome: 'refused', cause: 'not-begun' });

      expect(notices.take(wt)).toBeUndefined();
      expect(effects.flowChanged).toBe(0);
    });

    it('resets while holding the worktree lock: a live peer trying it at that moment is refused as held', () => {
      const r = probedRig();
      r.begin();

      expect(r.lifecycle.terminateUnattended(r.wt).outcome).toBe('reset');

      expect(r.probe()?.observed()).not.toHaveLength(0);
      for (const attempt of r.probe()?.observed() ?? []) expect(attempt).toMatchObject({ ok: false, cause: 'held' });
    });

    it('a lock whose holder cannot be identified refuses a Terminate, and its reason is posted exactly once', () => {
      const r = rig({ lock: (root) => createWorktreeLock({ lockRoot: root, holderLiveness: () => 'unreadable' }) });
      r.begin();
      r.holdAsPeer();
      const planted = readFileSync(worktreeLockFile(r.lockRoot, r.wt), 'utf8');
      const before = r.progression();

      const result = r.lifecycle.terminateUnattended(r.wt);

      expect(result).toMatchObject({ outcome: 'refused', cause: 'locked' });
      expectsUnidentifiedHolderRemedy(reasonOf(result) ?? '', worktreeLockFile(r.lockRoot, r.wt));
      expect(r.progression()).toBe(before);
      expect(r.audit.eventTypes(r.wt)).not.toContain('flow.terminated');
      expect(r.notices.take(r.wt)).toBe(reasonOf(result));
      expect(r.notices.take(r.wt)).toBeUndefined();
      expect(readFileSync(worktreeLockFile(r.lockRoot, r.wt), 'utf8')).toBe(planted);
    });

    it('T6c: an unusable lock directory does not block a Terminate, nothing is posted, and the file in its place is left as found', () => {
      const r = rig();
      r.begin();
      writeFileSync(r.lockRoot, 'not a lock directory\n');

      expect(r.lifecycle.terminateUnattended(r.wt).outcome).toBe('reset');

      expect(r.audit.eventTypes(r.wt)).toContain('flow.terminated');
      expect(r.notices.take(r.wt)).toBeUndefined();
      expect(readFileSync(r.lockRoot, 'utf8')).toBe('not a lock directory\n');
    });

    it.each(RECONSTRUCTIONS)('with %s the lock is rebuilt and really held while the run is reset', (_label, remove) => {
      const r = probedRig();
      r.begin();
      mkdirSync(r.lockRoot, { recursive: true });
      remove(r.lockRoot);

      expect(r.lifecycle.terminateUnattended(r.wt).outcome).toBe('reset');

      expect(r.probe()?.observed()).not.toHaveLength(0);
      for (const attempt of r.probe()?.observed() ?? []) expect(attempt).toMatchObject({ ok: false, cause: 'held' });
    });

    it('a begun run is reset with the reset effects and posts nothing', () => {
      const { wt, audit, effects, lifecycle, notices, begin } = rig();
      begin();

      expect(lifecycle.terminateUnattended(wt).outcome).toBe('reset');

      expect(audit.eventTypes(wt)).toContain('flow.terminated');
      expect(effects.monitorCleared).toBe(1);
      expect(notices.take(wt)).toBeUndefined();
    });
  });

  describe('rebind', () => {
    const heldRun = (r: ReturnType<typeof rig>): void => {
      r.begin();
      fx.removeRunRecord(r.wt);
    };
    const endRun = (r: ReturnType<typeof rig>): { endRunHeldAt: string } => {
      const held = heldRunOf(r.wt);
      if (held.hold === 'not-held') throw new Error('the run is not held');
      return { endRunHeldAt: held.step };
    };

    it('a resume forgets the old binding, tells the strip, and writes no audit entry and clears nothing', () => {
      const r = rig();
      heldRun(r);

      expect(r.lifecycle.rebind(r.wt, { origin: 'global', id: 'resume-flow' }, 'refuse')).toEqual({ ok: true, outcome: 'resumed' });

      expect(r.effects.forgotten).toEqual([r.wt]);
      expect(r.effects.flowChanged).toBeGreaterThan(0);
      expect(r.effects.monitorCleared).toBe(0);
      expect(r.todos.list(r.wt)).toHaveLength(1);
      expect(r.audit.runFiles(r.wt)).toHaveLength(1);
      expect(r.audit.eventTypes(r.wt)).not.toContain('flow.terminated');
    });

    it.each([
      ['resumes', 'resume-flow', 'resumed'],
      ['ends', 'other-flow', 'terminated'],
    ] as const)('a rebind that %s the run still reports it and tells the strip when forgetting the old binding throws', (_label, id, outcome) => {
      const r = rig({ forgetThrows: true });
      heldRun(r);

      const result = r.lifecycle.rebind(r.wt, { origin: 'global', id }, outcome === 'resumed' ? 'refuse' : endRun(r));

      expect(result).toMatchObject({ ok: true, outcome });
      expect(r.effects.flowChanged).toBeGreaterThan(0);
    });

    it('a no-match rebind ends the run: flow.terminated in the audit run, todos and the monitor cleared, the strip told, and the choice selected', () => {
      const r = rig();
      heldRun(r);

      expect(r.lifecycle.rebind(r.wt, { origin: 'global', id: 'other-flow' }, endRun(r))).toMatchObject({ ok: true, outcome: 'terminated' });

      expect(r.audit.runFiles(r.wt)).toHaveLength(1);
      expect(r.audit.eventTypes(r.wt).filter((t) => t === 'flow.terminated')).toHaveLength(1);
      expect(r.todos.list(r.wt)).toHaveLength(0);
      expect(r.effects.monitorCleared).toBeGreaterThan(0);
      expect(r.effects.flowChanged).toBeGreaterThan(0);
      expect([...new Set(r.effects.forgotten)]).toEqual([r.wt]);
      expect(readActiveFlow(r.wt)).toEqual({ kind: 'value', id: 'other-flow' });
      expect(r.notices.take(r.wt)).toBeUndefined();
      expect(r.manager.state(r.wt).status).toBe('not_started');
    });

    it('a no-match rebind whose selection write fails after the reset returns the notice and still runs every Terminate effect', () => {
      const r = rig();
      heldRun(r);
      fx.plantPointerDirectory(r.wt);

      const result = r.lifecycle.rebind(r.wt, { origin: 'global', id: 'other-flow' }, endRun(r));

      expect(result).toMatchObject({ ok: true, outcome: 'terminated', notice: expect.stringMatching(/could not be selected/) });
      expect(r.notices.take(r.wt)).toBeUndefined();
      expect(r.audit.eventTypes(r.wt).filter((t) => t === 'flow.terminated')).toHaveLength(1);
      expect(r.todos.list(r.wt)).toHaveLength(0);
      expect(r.effects.monitorCleared).toBeGreaterThan(0);
      expect(r.effects.flowChanged).toBeGreaterThan(0);
      expect([...new Set(r.effects.forgotten)]).toEqual([r.wt]);
    });

    it.skipIf(asRoot)('a no-match rebind the manager cannot reset writes no audit entry and runs no lifecycle effect', () => {
      const r = rig();
      heldRun(r);
      const before = r.progression();

      const result = withReadOnlyFlowHome(r.wt, () => r.lifecycle.rebind(r.wt, { origin: 'global', id: 'other-flow' }, endRun(r)));

      expect(reasonOf(result)).toMatch(/EACCES|permission/i);
      expect(reasonOf(result)).not.toMatch(/current step/i);
      expect(r.progression()).toBe(before);
      expect(r.audit.runFiles(r.wt)).toHaveLength(1);
      expect(r.audit.eventTypes(r.wt)).not.toContain('flow.terminated');
      expect(r.todos.list(r.wt)).toHaveLength(1);
      expect(r.effects).toEqual({ monitorCleared: 0, flowChanged: 0, forgotten: [], released: [] });
    });

    it.each(['resume-flow', 'other-flow'])('a %s choice is refused while an app-loop turn is in flight for the worktree, writing nothing and leaving it held', (id) => {
      const r = rig({ activeTurn: true });
      heldRun(r);
      const before = r.progression();
      const pointerBefore = readActiveFlow(r.wt);

      const result = r.lifecycle.rebind(r.wt, { origin: 'global', id }, endRun(r));

      expect(result.ok).toBe(false);
      expect(reasonOf(result)).toMatch(/turn/i);
      expect(r.progression()).toBe(before);
      expect(readRunBinding(r.wt)).toBeNull();
      expect(readActiveFlow(r.wt)).toEqual(pointerBefore);
      expect(r.audit.eventTypes(r.wt)).not.toContain('flow.terminated');
      expect(r.todos.list(r.wt)).toHaveLength(1);
      expect(r.effects).toEqual({ monitorCleared: 0, flowChanged: 0, forgotten: [], released: [] });
    });

    it('an unconfirmed no-match rebind is refused before the run is ended: no audit entry, no effect, still held (AC20)', () => {
      const r = rig();
      heldRun(r);
      const before = r.progression();
      const pointerBefore = readActiveFlow(r.wt);

      const result = r.lifecycle.rebind(r.wt, { origin: 'global', id: 'other-flow' }, 'refuse');

      expect(reasonOf(result)).toMatch(/ends? the run/i);
      expect(r.progression()).toBe(before);
      expect(readRunBinding(r.wt)).toBeNull();
      expect(readActiveFlow(r.wt)).toEqual(pointerBefore);
      expect(r.audit.eventTypes(r.wt)).not.toContain('flow.terminated');
      expect(r.todos.list(r.wt)).toHaveLength(1);
      expect(r.effects).toEqual({ monitorCleared: 0, flowChanged: 0, forgotten: [], released: [] });
    });

    it('a refused rebind runs no lifecycle effect', () => {
      const r = rig();
      heldRun(r);

      expect(r.lifecycle.rebind(r.wt, { origin: 'repo', id: 'resume-flow' }, endRun(r)).ok).toBe(false);

      expect(r.effects).toEqual({ monitorCleared: 0, flowChanged: 0, forgotten: [], released: [] });
      expect(r.audit.eventTypes(r.wt)).not.toContain('flow.terminated');
    });
  });
});

describe('the flow manager names why a Terminate was refused (A3 T6b)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  it.skipIf(asRoot)('a reset whose run record cannot be removed notices it display-safe and bounded (§18.7.6)', () => {
    const home = fx.makeWorktree('a3-mgr-notice-home');
    fx.writeFlowHome(home, { name: 'g', stepIds: ['s1'] });
    const wt = fx.makeWorktree('a3-mgr-notice-wt');
    const manager = createFlowManager({ globalDir: home });
    expect(manager.start(wt).status).toBe('in_progress');
    const record = runDispositionFile(wt);
    const stuck = join(record, `locked\u202e${'x'.repeat(220)}`);
    rmSync(record);
    mkdirSync(stuck, { recursive: true });
    writeFileSync(join(stuck, 'f'), '');
    chmodSync(stuck, 0o555);
    try {
      const result = manager.terminate(wt);

      expect(result.outcome).toBe('reset');
      const notice = result.view.notice ?? '';
      expect(notice).toMatch(/run record/);
      expect(notice).not.toMatch(/\u202e/u);
      expect(notice.length).toBeLessThanOrEqual(MAX_ECHOED_REASON_LENGTH);
    } finally {
      chmodSync(stuck, 0o755);
    }
  });

  it('a never-started run is refused with cause not-begun', () => {
    const home = fx.makeWorktree('a3-mgr-home');
    fx.writeFlowHome(home, { name: 'g', stepIds: ['s1'] });
    const wt = fx.makeWorktree('a3-mgr-wt');

    expect(createFlowManager({ globalDir: home }).terminate(wt)).toMatchObject({ outcome: 'refused', cause: 'not-begun' });
  });

  it.skipIf(asRoot)('a begun run whose progression cannot be reset is refused with cause failed', () => {
    const home = fx.makeWorktree('a3-mgr-fail-home');
    fx.writeFlowHome(home, { name: 'g', stepIds: ['s1'] });
    const wt = fx.makeWorktree('a3-mgr-fail-wt');
    const manager = createFlowManager({ globalDir: home, loadDefinition: (k) => createRunResolver(home)(k) });
    expect(manager.start(wt).status).toBe('in_progress');

    expect(withReadOnlyFlowHome(wt, () => manager.terminate(wt))).toMatchObject({ outcome: 'refused', cause: 'failed' });
  });
});
