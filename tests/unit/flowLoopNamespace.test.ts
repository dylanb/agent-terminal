import { describe, expect, it, vi } from 'vitest';
import { createFlowMachine, type FlowLoad } from '../../src/main/flow';
import type { AgentLoopState } from '../../src/main/agentLoopBridge';
import type { FlowLoopView } from '../../src/shared/ipc';

// §27.15 — the flow step's loop binding names which def namespace it means, and the loop-view provider is
// engine-selected on that binding. An `app`-namespace step feeds the §27 provider (readAppLoopView); a
// `legacy` step feeds the §26 provider (deriveLoopView). The two are independent: a §27-bound step renders
// its view with the §26 loop state absent, and a §26-bound step is untouched by the §27 seam.

const appLoad: FlowLoad = {
  ok: true,
  definition: { name: 'demo', steps: [{ id: 'plan', kind: 'loop', loop: 'plan-loop', loopNamespace: 'app' }] },
  flowDir: '',
};
const legacyLoad: FlowLoad = {
  ok: true,
  definition: { name: 'demo', steps: [{ id: 'plan', kind: 'loop', loop: 'plan-loop', loopNamespace: 'legacy' }] },
  flowDir: '',
};

const APP_VIEW: FlowLoopView = { status: 'not-started', pr: null, branch: null, ready: false, actionable: false, humanNeeded: false, gateOptions: ['approve', 'request-changes'] };

describe('createFlowMachine — engine-selected loop view (§27.15)', () => {
  it('feeds an app-namespace step through the §27 provider, with §26 loop state absent', () => {
    const readAppLoopView = vi.fn((): FlowLoopView => APP_VIEW);
    const readLoop = vi.fn((): AgentLoopState | null => null); // no §26 state on disk
    const machine = createFlowMachine(appLoad, undefined, undefined, readLoop, undefined, undefined, Date.now, readAppLoopView);
    machine.start();
    const view = machine.state();
    expect(view.loop).toEqual(APP_VIEW);
    expect(readAppLoopView).toHaveBeenCalledWith('plan-loop');
  });

  it('does not reach the §27 provider for a legacy-namespace step', () => {
    const readAppLoopView = vi.fn((): FlowLoopView => APP_VIEW);
    const readLoop = vi.fn((): AgentLoopState | null => null);
    const machine = createFlowMachine(legacyLoad, undefined, undefined, readLoop, undefined, undefined, Date.now, readAppLoopView);
    machine.start();
    machine.state();
    expect(readAppLoopView).not.toHaveBeenCalled();
  });

  it('omits the loop view for an app step when no §27 provider is wired (tests / §26-only)', () => {
    const machine = createFlowMachine(appLoad, undefined, undefined, () => null);
    machine.start();
    expect(machine.state().loop).toBeUndefined();
  });
});
