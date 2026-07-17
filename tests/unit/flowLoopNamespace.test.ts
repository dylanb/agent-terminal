import { describe, expect, it, vi } from 'vitest';
import { createFlowMachine, legacyLoopNameForStep, type FlowLoad } from '../../src/main/flow';
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

  // The §27 provider owns the WHOLE app view and reads no §26 state; the flow module must not source refs
  // from a stray §26 state.yaml either (a Parnas information-hiding leak). A pure-app flow in a repo that
  // happens to carry a §26 state.yaml surfaces none of that engine's ticket/PR on its §27 step.
  it('sources no ticket/PR refs from §26 loop state on an app-namespace step', () => {
    const readAppLoopView = vi.fn((): FlowLoopView => APP_VIEW);
    const stray26: AgentLoopState = { status: 'planning', iteration: 3, pr: 42, branch: 'feat/x', linkedIssues: [7] };
    const readLoop = vi.fn((): AgentLoopState | null => stray26);
    const machine = createFlowMachine(appLoad, undefined, undefined, readLoop, undefined, undefined, Date.now, readAppLoopView);
    machine.start();
    expect(machine.state().refs).toBeUndefined();
  });
});

// §27.15 — the gate-decision WRITE half is engine-selected on the same binding as the read/entry halves.
// The §26 gate executor resolves its target through this selector: an app-namespace step resolves NO §26
// loop name, so a decision arriving for a §27-bound step is refused before it dispatches into the §26 write
// path — even on a machine holding a same-named §26 def.
describe('legacyLoopNameForStep — gate-decision write-half guard (§27.15)', () => {
  it('resolves no §26 loop name for an app-namespace loop step', () => {
    expect(legacyLoopNameForStep({ id: 'plan', kind: 'loop', loop: 'plan-loop', loopNamespace: 'app' })).toBeNull();
  });

  it('resolves the bound §26 name for a legacy-namespace loop step', () => {
    expect(legacyLoopNameForStep({ id: 'plan', kind: 'loop', loop: 'plan-loop', loopNamespace: 'legacy' })).toBe('plan-loop');
  });

  it('resolves the bound §26 name when the namespace is absent (defaults to §26)', () => {
    expect(legacyLoopNameForStep({ id: 'plan', kind: 'loop', loop: 'plan-loop' })).toBe('plan-loop');
  });

  it('resolves no name for a manual step or a missing step', () => {
    expect(legacyLoopNameForStep({ id: 'polish', kind: 'manual' })).toBeNull();
    expect(legacyLoopNameForStep(undefined)).toBeNull();
  });
});
