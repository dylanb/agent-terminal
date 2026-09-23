import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { createFlowManager, flowHomeDir } from '../../src/main/flow';
import { createRunResolver } from '../../src/main/runResolver';
import { runDispositionFile } from '../../src/main/runDisposition';
import { worktreeStartedness } from '../../src/main/startedness';

// A2 (#133) §18.7.2 AC6 / §18.7.3 AC9 — Terminate is the route out of every begun run, including one held at the
// §18.1 error because its recorded source cannot be verified. Driven through the production resolver wiring.
describe('Terminate recovers every begun run (§18.7.2 AC6, §18.7.3 AC9)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());
  const asRoot = process.getuid?.() === 0;

  const setup = (prefix: string) => {
    const wt = fx.makeWorktree(prefix);
    const globalDir = fx.makeWorktree(`${prefix}-global`);
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['red', 'green'] });
    const resolve = createRunResolver(globalDir);
    const mgr = createFlowManager({ globalDir, loadDefinition: (k) => resolve(k) });
    return { wt, mgr };
  };

  it('Terminate of an app-started run resets it to not_started and unlocks a new selection', () => {
    const { wt, mgr } = setup('a2-term-started');
    expect(mgr.start(wt).status).toBe('in_progress');

    const after = mgr.terminate(wt);

    expect(after.outcome).toBe('reset');
    expect(after.view.status).toBe('not_started');
    expect(after.view.runStarted).toBe('never-started');
    expect(mgr.state(wt).status).toBe('not_started');
  });

  it('a begun run with no source record is held at the error, and Terminate resets it keeping its title', () => {
    const { wt, mgr } = setup('a2-term-no-record');
    fx.writeFlowStateRaw(wt, 'step: green\nstatus: in_progress\ntitle: Refactor the parser\n');
    const held = mgr.state(wt);
    expect(held.status).toBe('error');
    expect(held.runStarted).toBe('started');

    const after = mgr.terminate(wt);

    expect(after.outcome).toBe('reset');
    expect(after.view.status).toBe('not_started');
    expect(after.view.runStarted).toBe('never-started');
    expect(after.view.userTitle).toBe('Refactor the parser');
  });

  it('a begun run whose source record is corrupt is held at the error, and Terminate resets it', () => {
    const { wt, mgr } = setup('a2-term-corrupt-record');
    fx.writeFlowState(wt, { step: 'green', status: 'in_progress' });
    writeFileSync(runDispositionFile(wt), 'source: totally-bogus\n');
    expect(mgr.state(wt).status).toBe('error');

    const after = mgr.terminate(wt);

    expect(after.outcome).toBe('reset');
    expect(after.view.status).toBe('not_started');
    expect(existsSync(runDispositionFile(wt))).toBe(false);
    expect(worktreeStartedness(wt)).toBe('never-started');
  });

  it('Terminate on a never-started worktree whose flow fails to load is refused and writes nothing', () => {
    const wt = fx.makeWorktree('a2-term-never-started-error');
    const globalDir = fx.makeWorktree('a2-term-never-started-error-global');
    const resolve = createRunResolver(globalDir);
    const mgr = createFlowManager({ globalDir, loadDefinition: (k) => resolve(k) });
    expect(mgr.state(wt).status).toBe('error');

    const after = mgr.terminate(wt);

    expect(after.outcome).toBe('refused');
    expect(existsSync(join(flowHomeDir(wt), 'flow-state.yaml'))).toBe(false);
  });

  it.skipIf(asRoot)('a held run whose progression cannot be reset is refused with a reason and stays begun', () => {
    const { wt, mgr } = setup('a2-term-held-fault');
    const stateFile = fx.writeFlowState(wt, { step: 'green', status: 'in_progress' });
    const before = readFileSync(stateFile, 'utf8');
    chmodSync(flowHomeDir(wt), 0o555);
    try {
      const after = mgr.terminate(wt);
      expect(after.outcome).toBe('refused');
      expect(after.view.notice).toMatch(/could not be terminated/);
    } finally {
      chmodSync(flowHomeDir(wt), 0o755);
    }
    expect(readFileSync(stateFile, 'utf8')).toBe(before);
    expect(worktreeStartedness(wt)).toBe('started');
  });
});
