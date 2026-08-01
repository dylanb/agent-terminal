import { describe, expect, it, vi } from 'vitest';
import { createFlowMachine, type FlowLoad } from '../../src/main/flow';
import type { FlowLoopView } from '../../src/shared/ipc';

// §27.15 / AC 4 — the loop-view provider is engine-selected on the most-recent loop step's parsed binding.
// Absence and an explicit `app` binding select the surviving §27 provider (readAppLoopView); the
// recognized-but-retired `legacy` marker names no surviving engine, so it yields a marked-binding error loop
// view whose reason names the real cause, rather than reaching any provider. An unrecognized namespace never
// reaches here — it is a whole-file rejection at flow-load (AC 4).

const appLoad: FlowLoad = {
  ok: true,
  definition: { name: 'demo', steps: [{ id: 'plan', kind: 'loop', loop: 'plan-loop', loopNamespace: 'app' }] },
  flowDir: '',
};
const bareLoad: FlowLoad = {
  ok: true,
  definition: { name: 'demo', steps: [{ id: 'plan', kind: 'loop', loop: 'plan-loop' }] },
  flowDir: '',
};
const legacyLoad: FlowLoad = {
  ok: true,
  definition: { name: 'demo', steps: [{ id: 'plan', kind: 'loop', loop: 'plan-loop', loopNamespace: 'legacy' }] },
  flowDir: '',
};

const APP_VIEW: FlowLoopView = { status: 'not-started', pr: null, branch: null, ready: false, actionable: false, humanNeeded: false, gateOptions: ['approve', 'request-changes'] };

describe('createFlowMachine — engine-selected loop view (§27.15 / AC 4)', () => {
  it('feeds an explicit app-namespace step through the §27 provider', () => {
    const readAppLoopView = vi.fn((): FlowLoopView => APP_VIEW);
    const machine = createFlowMachine(appLoad, undefined, undefined, readAppLoopView);
    machine.start();
    expect(machine.state().loop).toEqual(APP_VIEW);
    expect(readAppLoopView).toHaveBeenCalledWith('plan-loop');
  });

  it('feeds a namespace-less step through the §27 provider (absence selects the surviving engine — AC 4)', () => {
    const readAppLoopView = vi.fn((): FlowLoopView => APP_VIEW);
    const machine = createFlowMachine(bareLoad, undefined, undefined, readAppLoopView);
    machine.start();
    expect(machine.state().loop).toEqual(APP_VIEW);
    expect(readAppLoopView).toHaveBeenCalledWith('plan-loop');
  });

  it('yields a marked-binding error loop view for a legacy step, never reaching the §27 provider (AC 4)', () => {
    const readAppLoopView = vi.fn((): FlowLoopView => APP_VIEW);
    const machine = createFlowMachine(legacyLoad, undefined, undefined, readAppLoopView);
    machine.start();
    const loop = machine.state().loop;
    expect(loop?.status).toBe('error');
    expect(loop?.humanNeeded).toBe(true);
    // The reason-accuracy rule: the error names the real cause (the retired binding), not a generic failure.
    expect(loop?.errorReason).toContain('legacy');
    expect(readAppLoopView).not.toHaveBeenCalled();
  });

  it('omits the loop view for an app step when no §27 provider is wired', () => {
    const machine = createFlowMachine(appLoad);
    machine.start();
    expect(machine.state().loop).toBeUndefined();
  });
});
