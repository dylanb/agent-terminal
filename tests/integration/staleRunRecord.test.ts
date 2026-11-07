import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { createFlowManager } from '../../src/main/flow';
import { createRunResolver } from '../../src/main/runResolver';
import { readRunBinding, runDispositionFile } from '../../src/main/runDisposition';
import { MAX_ECHOED_LOCK_REASON_LENGTH } from '../../src/shared/controlChars';
import { repoOnlyDefTiers } from '../helpers/defTiers';

// A3 (#134) §18.7.2 / §18.7.4 — a Terminate resets the run and then removes its run record; when that removal fails
// the record is left behind on a run that is no longer begun. Start is the way out the picker names, so Start
// retries the removal, and when it still cannot remove it names the file to delete (CODE-STANDARDS: never an
// unrecoverable state).

const asRoot = process.getuid?.() === 0;

describe('Start after a reset that left its run record behind', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  function rig() {
    const home = fx.makeWorktree('a3-stale-home');
    fx.writeFlowHome(home, { name: 'global-fallback', stepIds: ['f1', 'f2'] });
    const wt = fx.makeWorktree('a3-stale-wt');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['l1', 'l2'] });
    const manager = () => createFlowManager({ globalDir: home, loadDefinition: (repoKey) => createRunResolver(home, repoOnlyDefTiers())(repoKey) });
    return { wt, manager };
  }

  it('removes a leftover record the rename cannot replace and begins the run', () => {
    const { wt, manager } = rig();
    fx.plantRunRecordDirectory(wt);

    const started = manager().start(wt);

    expect(started.notice).toBeUndefined();
    expect(started.status).toBe('in_progress');
    expect(started.stepName).toBe('l1');
    expect(readRunBinding(wt)).toEqual({ source: 'non-catalog' });
  });

  it('removes a leftover record planted after a real Terminate reset, and begins the run', () => {
    const { wt, manager } = rig();
    expect(manager().start(wt).status).toBe('in_progress');
    expect(manager().terminate(wt).outcome).toBe('reset');
    const record = runDispositionFile(wt);
    rmSync(record, { force: true });
    mkdirSync(join(record, 'left-behind'), { recursive: true });
    writeFileSync(join(record, 'left-behind', 'f'), '');

    const started = manager().start(wt);

    expect(started.status).toBe('in_progress');
    expect(readRunBinding(wt)).toEqual({ source: 'non-catalog' });
  });

  it.skipIf(asRoot)('names the record to delete when it still cannot be removed, and starts once it can', () => {
    const { wt, manager } = rig();
    const record = runDispositionFile(wt);
    const stuck = join(record, 'locked');
    mkdirSync(stuck, { recursive: true });
    writeFileSync(join(stuck, 'f'), '');
    chmodSync(stuck, 0o555);
    let refused: ReturnType<ReturnType<typeof manager>['start']>;
    try {
      refused = manager().start(wt);
    } finally {
      chmodSync(stuck, 0o755);
    }

    expect(refused.status).toBe('not_started');
    expect(refused.notice ?? '').toContain(record);
    expect(refused.notice ?? '').toMatch(/delete/i);
    expect(refused.notice ?? '').toMatch(/start again/i);
    expect((refused.notice ?? '').length).toBeLessThanOrEqual(MAX_ECHOED_LOCK_REASON_LENGTH);
    expect(lstatSync(record).isDirectory()).toBe(true);

    const retried = manager().start(wt);
    expect(retried.status).toBe('in_progress');
    expect(readRunBinding(wt)).toEqual({ source: 'non-catalog' });
  });

  it('never removes the record of a run that is still begun: a held run keeps it', () => {
    const { wt, manager } = rig();
    fx.writeFlowState(wt, { step: 'l2', status: 'in_progress' });
    fx.plantRunRecordDirectory(wt);

    manager().start(wt);

    expect(lstatSync(runDispositionFile(wt)).isDirectory()).toBe(true);
  });
});
