import { describe, expect, it } from 'vitest';
import { createFlowMachine, type FlowLoad } from '../../src/main/flow';
import type { FlowLoopView } from '../../src/shared/ipc';

const gateView = (gateOptions: string[]): FlowLoopView => ({
  status: 'complete',
  pr: null,
  branch: null,
  ready: false,
  actionable: true,
  humanNeeded: true,
  appTurn: { step: 'integration', turnKey: 't1' },
  gateOptions,
});

const loadWith = (repeatOn: string | null): FlowLoad => ({
  ok: true,
  definition: {
    name: 'f',
    steps: [
      { id: 'plan', kind: 'loop', loop: 'plan-loop' },
      { id: 'dev', kind: 'loop', loop: 'dev-loop' },
      {
        id: 'integration',
        kind: 'loop',
        loop: 'integration-loop',
        ...(repeatOn ? { repeat: { backTo: repeatOn, countInput: 'slices' } } : {}),
      },
    ],
  },
  flowDir: '',
});

const atIntegration = (load: FlowLoad, view: FlowLoopView): ReturnType<typeof createFlowMachine> => {
  const flow = createFlowMachine(load, undefined, undefined, () => view);
  flow.start();
  flow.advance();
  flow.advance();
  return flow;
};

describe('the loop view names the step a back-to-red decision returns to', () => {
  it('names the repeat step back_to target when the gate offers back-to-red', () => {
    const flow = atIntegration(loadWith('dev'), gateView(['approve', 'back-to-red']));
    expect(flow.state().loop?.reopenStep).toBe('dev');
  });

  it('names a different target when the flow returns somewhere else', () => {
    const flow = atIntegration(loadWith('plan'), gateView(['approve', 'back-to-red']));
    expect(flow.state().loop?.reopenStep).toBe('plan');
  });

  it('names no target when the gate does not offer back-to-red', () => {
    const flow = atIntegration(loadWith('dev'), gateView(['approve', 'redo']));
    expect(flow.state().loop).toBeDefined();
    expect(flow.state().loop?.reopenStep).toBeUndefined();
  });

  it('names no target when the flow declares no repeat step to return to', () => {
    const flow = atIntegration(loadWith(null), gateView(['approve', 'back-to-red']));
    expect(flow.state().loop).toBeDefined();
    expect(flow.state().loop?.reopenStep).toBeUndefined();
  });
});
