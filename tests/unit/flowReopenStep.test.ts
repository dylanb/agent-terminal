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

describe('the back-to-red control follows the recorded decision', () => {
  const branchedLoad: FlowLoad = {
    ok: true,
    definition: {
      name: 'f',
      steps: [
        { id: 'triage', kind: 'loop', loop: 'groom-loop', decides: ['fix', 'close'] },
        { id: 'red', kind: 'loop', loop: 'dev-loop', when: { step: 'triage', value: 'fix' } },
        { id: 'integration', kind: 'loop', loop: 'integration-loop', when: { step: 'triage', value: 'fix' }, repeat: { backTo: 'red', countInput: 'slices' } },
        { id: 'wrap', kind: 'loop', loop: 'wrap-loop' },
      ],
    },
    flowDir: '',
  };

  it('names no target when the decision rules out the step it would return to', () => {
    const flow = createFlowMachine(branchedLoad, undefined, undefined, () => gateView(['approve', 'back-to-red']));
    flow.start();
    flow.recordDecision('triage', { value: 'close' });
    expect(flow.advance().stepName).toBe('wrap');
    expect(flow.state().loop).toBeDefined();
    expect(flow.state().loop?.reopenStep).toBeUndefined();
  });

  it('names the target when the decision takes the path through it', () => {
    const flow = createFlowMachine(branchedLoad, undefined, undefined, () => gateView(['approve', 'back-to-red']));
    flow.start();
    flow.recordDecision('triage', { value: 'fix' });
    flow.advance();
    expect(flow.advance().stepName).toBe('integration');
    expect(flow.state().loop?.reopenStep).toBe('red');
  });
});
