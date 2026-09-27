import { describe, it, expect, afterEach } from 'vitest';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { createFlowManager } from '../../src/main/flow';

// A2 (#133) §18.7.4 — every §18.1 flow view carries the RAW durable run started-ness (distinct from the
// load-maskable display `status`), fresh per call, so A3's picker-enable can classify it with isSelectionLocked.
describe('FlowStateView.runStarted — raw durable started-ness on the flow view (§18.7.4)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  const run = (prefix: string) => {
    const wt = fx.makeWorktree(prefix);
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['red', 'green'] });
    return { wt, mgr: createFlowManager({ globalDir: fx.makeWorktree(`${prefix}-global`) }) };
  };

  it('tracks never-started → started → (a first-step revertStep resets to) never-started → started → Terminate → never-started', () => {
    const { wt, mgr } = run('a2-runstarted');
    expect(mgr.state(wt).runStarted).toBe('never-started');
    expect(mgr.start(wt).runStarted).toBe('started');
    const reverted = mgr.revertStep(wt, 'red');
    expect(reverted.status).toBe('not_started');
    expect(reverted.runStarted).toBe('never-started');
    expect(mgr.start(wt).runStarted).toBe('started');
    expect(mgr.terminate(wt).view.runStarted).toBe('never-started');
    expect(mgr.state(wt).runStarted).toBe('never-started');
  });

  it('reports indeterminate for an unverifiable progression, on the error hold view too', () => {
    const { wt, mgr } = run('a2-runstarted-indet');
    fx.writeFlowStateRaw(wt, '[unterminated flow sequence');
    expect(mgr.state(wt).runStarted).toBe('indeterminate');
  });
});
