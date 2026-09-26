import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { createFlowManager, flowHomeDir } from '../../src/main/flow';
import { MAX_ECHOED_REASON_LENGTH } from '../../src/shared/controlChars';
import type { HeldRunView } from '../../src/shared/runHold';
import { heldRunOf } from '../../src/main/runHoldRead';

// A3 (#134) §18.7.3 / §18.7.4 — the flow manager's view reports whether a run is held: definitely begun (a valid
// in_progress/done progression) with a missing or unreadable run record. A corrupt progression is indeterminate,
// not held, whatever the record says, and a rollback (not_started + record) is not held.

const CAN_SYMLINK = process.platform !== 'win32';

describe('the flow view reports the run hold (§18.7.3 shared classification)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  function worktree(prefix: string): string {
    const wt = fx.makeWorktree(prefix);
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['s1', 's2', 's3'] });
    return wt;
  }

  function runHoldOf(wt: string): HeldRunView | undefined {
    const globalDir = fx.makeWorktree('a3-hold-global');
    return createFlowManager({ globalDir }).state(wt).runHold;
  }

  /** The renderer's recovery offer and main's rebind refusal read the same classification, so they cannot disagree. */
  function expectHold(wt: string, expected: HeldRunView): void {
    expect(runHoldOf(wt)).toEqual(expected);
    expect(heldRunOf(wt).hold, "the rebind's held read agrees with the view").toBe(expected.hold);
  }

  const flowStateFile = (wt: string): string => join(flowHomeDir(wt), 'flow-state.yaml');

  it('a missing record under an in_progress progression is held as record-missing, with its step and status', () => {
    const wt = worktree('a3-hold-missing-ip');
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.removeRunRecord(wt);

    expectHold(wt, { hold: 'record-missing', step: 's2', status: 'in_progress' });
  });

  it('a missing record under a done progression is held as record-missing, with its step and status', () => {
    const wt = worktree('a3-hold-missing-done');
    fx.writeFlowState(wt, { step: 's3', status: 'done' });

    expectHold(wt, { hold: 'record-missing', step: 's3', status: 'done' });
  });

  it('a garbage record under a begun progression is held as record-unreadable', () => {
    const wt = worktree('a3-hold-garbage');
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.writeRunRecordRaw(wt, '[unterminated flow sequence');

    expectHold(wt, { hold: 'record-unreadable', step: 's2', status: 'in_progress' });
  });

  it('a present record whose binding does not parse is held as record-unreadable', () => {
    const wt = worktree('a3-hold-badbinding');
    fx.writeFlowState(wt, { step: 's2', status: 'done' });
    fx.writeRunRecordRaw(wt, 'schema_version: 1\nsource: catalog\ntier: nowhere\nid: x\n');

    expectHold(wt, { hold: 'record-unreadable', step: 's2', status: 'done' });
  });

  it('a directory at the record path is held as record-unreadable', () => {
    const wt = worktree('a3-hold-dir');
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.plantRunRecordDirectory(wt);

    expectHold(wt, { hold: 'record-unreadable', step: 's2', status: 'in_progress' });
  });

  it.skipIf(!CAN_SYMLINK)('a symlinked record over a valid in_progress progression is held as record-unreadable, not indeterminate', () => {
    const wt = worktree('a3-hold-symlink');
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    const target = join(fx.outsideDir('a3-hold-symlink-target'), 'run-disposition.yaml');
    writeFileSync(target, 'schema_version: 1\nsource: non-catalog\n');
    fx.plantRunRecordSymlink(wt, target);

    expectHold(wt, { hold: 'record-unreadable', step: 's2', status: 'in_progress' });
  });

  it('an intact record under a begun progression is not held', () => {
    const wt = worktree('a3-hold-intact');
    fx.writeFlowState(wt, { step: 's2', status: 'in_progress' });
    fx.writeRunRecord(wt, { source: 'non-catalog' });

    expectHold(wt, { hold: 'not-held' });
  });

  it('a first-step rollback (not_started with the record present) is not held', () => {
    const wt = worktree('a3-hold-rollback');
    fx.writeFlowState(wt, { step: 's1', status: 'not_started' });
    fx.writeRunRecord(wt, { source: 'non-catalog' });

    expectHold(wt, { hold: 'not-held' });
  });

  it('a not_started progression with the record missing is not held', () => {
    const wt = worktree('a3-hold-rollback-missing');
    fx.writeFlowState(wt, { step: 's1', status: 'not_started' });
    fx.removeRunRecord(wt);

    expectHold(wt, { hold: 'not-held' });
  });

  it('a not_started progression with a garbage record is not held', () => {
    const wt = worktree('a3-hold-rollback-garbage');
    fx.writeFlowState(wt, { step: 's1', status: 'not_started' });
    fx.writeRunRecordRaw(wt, '[unterminated flow sequence');

    expectHold(wt, { hold: 'not-held' });
  });

  it('a never-started worktree is not held', () => {
    const wt = worktree('a3-hold-never');

    expectHold(wt, { hold: 'not-held' });
  });

  const INDETERMINATE: [string, (wt: string) => void][] = [
    ['unreadable (a directory at flow-state.yaml)', (wt) => mkdirSync(flowStateFile(wt), { recursive: true })],
    ['unparseable (garbage YAML)', (wt) => fx.writeFlowStateRaw(wt, '[unterminated flow sequence')],
    ['a begun status with no step', (wt) => fx.writeFlowStateRaw(wt, 'status: in_progress\n')],
    ['a step with no status', (wt) => fx.writeFlowStateRaw(wt, 'step: s2\n')],
    ['a status outside the persistable vocabulary', (wt) => fx.writeFlowStateRaw(wt, 'step: s2\nstatus: paused\n')],
  ];

  it.each(INDETERMINATE)('an indeterminate progression — %s — with the record missing is not held', (_label, plant) => {
    const wt = worktree('a3-hold-indet');
    plant(wt);
    fx.removeRunRecord(wt);

    expectHold(wt, { hold: 'not-held' });
  });

  it('a hostile held step is shown display-safe and bounded (§18.7.6)', () => {
    const wt = worktree('a3-hold-hostile');
    const hostile = `s‮​x\u0007${'y'.repeat(MAX_ECHOED_REASON_LENGTH * 2)}`;
    fx.writeFlowState(wt, { step: hostile, status: 'in_progress' });

    const hold = runHoldOf(wt);

    expect(hold).toMatchObject({ hold: 'record-missing', status: 'in_progress' });
    const step = hold !== undefined && hold.hold !== 'not-held' ? hold.step : '';
    expect(step).not.toMatch(/[‮​\u0000-\u001F]/);
    expect(step.length).toBeGreaterThan(0);
    expect(step.length).toBeLessThanOrEqual(MAX_ECHOED_REASON_LENGTH);
    expect(heldRunOf(wt).hold, "the rebind's held read agrees with the view").toBe('record-missing');
  });
});
