import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync } from 'node:fs';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { createFlowManager, flowHomeDir } from '../../src/main/flow';
import { worktreeStartedness } from '../../src/main/startedness';
import { readDisposition, readRunBinding } from '../../src/main/runDisposition';
import { createFlowStateStore } from '../../src/main/flowState';

// §18.7.4 — a first-step rollback returns the run to fully "not started":
// the run record goes with it, so the picker unlocks with no Terminate (which the strip never offers on
// not_started). A rollback from a later step keeps the record: that run is still begun.
describe('revertStep and the run record (§18.7.4)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  const begun = (prefix: string) => {
    const wt = fx.makeWorktree(prefix);
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['red', 'green'] });
    const mgr = createFlowManager({ globalDir: fx.makeWorktree(`${prefix}-global`) });
    mgr.start(wt);
    return { wt, mgr };
  };

  it('a first-step rollback deletes the run record, unlocking selection, and a new Start begins a run', () => {
    const { wt, mgr } = begun('a3-revert-first');

    const reverted = mgr.revertStep(wt, 'red');

    expect(reverted.status).toBe('not_started');
    expect(reverted.runStarted).toBe('never-started');
    expect(readDisposition(wt)).toBe('absent');
    expect(worktreeStartedness(wt)).toBe('never-started');
    const restarted = mgr.start(wt);
    expect(restarted.status).toBe('in_progress');
    expect(restarted.runStarted).toBe('started');
  });

  it("a first-step rollback discards the run's resolved inputs, so the next Start's step 0 asks afresh", () => {
    const wt = fx.makeWorktree('a3-revert-first-inputs');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['red', 'green'] });
    const seen: Record<string, string>[] = [];
    const mgr = createFlowManager({
      globalDir: fx.makeWorktree('a3-revert-first-inputs-global'),
      onEnterStep: (_step, inputs) => void seen.push({ ...inputs }),
    });
    mgr.start(wt);
    mgr.provideInput(wt, { ticket: '134' });

    mgr.revertStep(wt, 'red');
    mgr.start(wt);

    expect(seen.at(-1)).toEqual({});
  });

  it('a rollback from a later step keeps the run record, so selection stays locked', () => {
    const { wt, mgr } = begun('a3-revert-later');
    mgr.advance(wt);

    const reverted = mgr.revertStep(wt, 'green');

    expect(reverted.status).toBe('in_progress');
    expect(reverted.stepName).toBe('red');
    expect(readDisposition(wt)).toBe('present');
    expect(worktreeStartedness(wt)).toBe('started');
  });

  it('a reset that cannot be written after the record was removed restores the record, leaving the run in_progress and begun', () => {
    const wt = fx.makeWorktree('a3-revert-first-reset-fault');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['red', 'green'] });
    let failWrites = false;
    const mgr = createFlowManager({
      globalDir: fx.makeWorktree('a3-revert-first-reset-fault-global'),
      makeStore: (k) => {
        const store = createFlowStateStore(k);
        return {
          ...store,
          write: (state) => {
            if (failWrites) throw new Error('ENOSPC: no space left on device');
            store.write(state);
          },
        };
      },
    });
    mgr.start(wt);
    const record = readRunBinding(wt);
    failWrites = true;

    expect(() => mgr.revertStep(wt, 'red')).toThrow(/ENOSPC/);

    expect(readRunBinding(wt)).toEqual(record);
    expect(worktreeStartedness(wt)).toBe('started');
    expect(mgr.state(wt)).toMatchObject({ status: 'in_progress', stepName: 'red' });
  });

  const asRoot = process.getuid?.() === 0; // root ignores the 0o555 fault this pin injects

  it.skipIf(asRoot)('a record that cannot be deleted refuses the rollback, leaving the run in_progress where Terminate retries the delete', () => {
    const { wt, mgr } = begun('a3-revert-first-fault');
    chmodSync(flowHomeDir(wt), 0o555);
    try {
      expect(() => mgr.revertStep(wt, 'red')).toThrow(/run record could not be removed/);
      const held = mgr.state(wt);
      expect(held.status).toBe('in_progress');
      expect(held.runStarted).toBe('started');
    } finally {
      chmodSync(flowHomeDir(wt), 0o755);
    }
    const terminated = mgr.terminate(wt);
    expect(terminated.outcome).toBe('reset');
    expect(terminated.view.runStarted).toBe('never-started');
  });
});
