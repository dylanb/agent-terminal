import { describe, expect, it } from 'vitest';
import { createFlowMachine, type FlowLoad } from '../../src/main/flow';
import { createFlowEntryActions } from '../../src/main/flowEntryActions';

const load: FlowLoad = { ok: true, flowDir: '/flow', definition: { name: 'Inputs', steps: [
  { id: 'first', kind: 'manual', inputs: [{ name: 'ticket', type: 'github-ticket', required: true }] },
  { id: 'repeat', kind: 'manual', inputs: [{ name: 'note', type: 'free-text', required: true }], repeat: { backTo: 'first', countInput: 'slices' } },
  { id: 'last', kind: 'manual', inputs: [{ name: 'result', type: 'free-text', required: true }] },
] } };
const entry = createFlowEntryActions({ isShellBusy: () => false, inject: () => {}, prepareLoopBinding: () => ({ kind: 'ready' }), enterAppLoop: () => {} });

describe('inputs supplied at a flow transition', () => {
  it('enters the first step with supplied values and no input modal', () => {
    const flow = createFlowMachine(load, undefined, entry);
    expect(flow.entryInputs?.('start')).toEqual([{ name: 'ticket', type: 'github-ticket', required: true, value: undefined }]);
    expect(flow.start({ startedAt: 1, inputs: { ticket: '322', slices: '2' } }).prompt).toBeUndefined();
    expect(flow.state().refs?.ticket).toBe(322);
  });
  it('preflights the actual next step including repeat and resolved inputs', () => {
    const flow = createFlowMachine(load, undefined, entry);
    flow.start({ startedAt: 1, inputs: { ticket: '322', slices: '2' } });
    expect(flow.entryInputs?.('approve')).toEqual([{ name: 'note', type: 'free-text', required: true, value: undefined }]);
    expect(flow.advance({ note: 'ready' }).prompt).toBeUndefined();
    expect(flow.entryInputs?.('approve')).toEqual([{ name: 'ticket', type: 'github-ticket', required: true, value: '322' }]);
    expect(flow.advance().stepName).toBe('first');
    expect(flow.advance().prompt).toBeUndefined();
    expect(flow.entryInputs?.('approve')).toEqual([{ name: 'result', type: 'free-text', required: true, value: undefined }]);
    expect(flow.advance({ result: 'done' }).prompt).toBeUndefined();
    expect(flow.entryInputs?.('approve')).toEqual([]);
    expect(flow.advance().status).toBe('done');
  });
});
