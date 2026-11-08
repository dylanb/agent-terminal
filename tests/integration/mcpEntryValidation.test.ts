import { expect, it } from 'vitest';
import { createFlowMachine, type FlowLoad } from '../../src/main/flow';
import { createMcpActions } from '../../src/main/mcpActions';
import { toolResult } from '../../src/main/mcpTools';
import type { McpWindowState } from '../../src/shared/mcpWindowState';

function fixture(tool: 'start' | 'approve', type: string) {
  const load: FlowLoad = { ok: true, flowDir: '/flow', definition: { name: 'entry', steps: [
    ...(tool === 'approve' ? [{ id: 'before', kind: 'manual' as const }] : []),
    { id: 'entry', kind: 'manual', inputs: [{ name: 'reference', type, required: false }] },
  ] } };
  const entered: Record<string, string>[] = [];
  const flow = createFlowMachine(load, undefined, (_step, values) => { entered.push({ ...values }); });
  if (tool === 'approve') flow.start();
  const read = (): McpWindowState => ({ window: { id: 'w' }, repo: { key: '/repo' }, flow: { selected: null, steps: flow.state().steps, step: flow.state().stepName, status: flow.state().status, runStarted: tool === 'approve' }, selectionUnusable: false,
    gate: tool === 'approve' ? { step: 'before', turn: null, options: ['approve'], reasons: [], engineDeciding: false } : null,
    stalledTurn: null, loopMessage: null, roundReport: null, todos: [], startable: [], startableError: null, terminateTodoCount: 0 });
  const actions = createMcpActions({ windowId: 'w', originOf: async () => 'human', readState: async () => read(), readGateState: read,
    gate: { autoGate: { humanDecision: () => () => {} }, pickupHold: () => null, bindingOf: () => null, approve: async () => ({ kind: 'advanced', effectFailures: [] }) },
    entryInputs: (_repo, action) => flow.entryInputs(action),
    start: (_repo, inputs) => { flow.start({ startedAt: 1, inputs }); return { kind: 'started' }; },
    advance: (_repo, _step, inputs) => { flow.advance(inputs); return { kind: 'advanced' }; },
  });
  return { snapshot: () => ({ state: flow.state(), entered: structuredClone(entered) }), entered,
    call: async (inputs: Record<string, string>) => toolResult({ kind: 'answered', value: await actions.call({ tool, args: { window: 'w', repo: '/repo', ...(tool === 'approve' ? { step: 'before' } : {}), inputs } }, { session: 1 }) }) };
}

for (const tool of ['start', 'approve'] as const) {
  it.each(['github-ticket', 'pr'])(`${tool} refuses a malformed optional %s before entering`, async type => {
    const f = fixture(tool, type); const before = f.snapshot();
    const result = await f.call({ reference: 'not-a-number' });
    expect({ error: result.isError, message: result.content[0].text, after: f.snapshot() }).toEqual({ error: true, message: expect.stringMatching(/not valid.*reference/is), after: before });
  });
  it(`${tool} does not demand an omitted optional input and accepts a valid supplied one`, async () => {
    const omitted = fixture(tool, 'github-ticket');
    expect((await omitted.call({})).isError).toBe(false);
    expect(omitted.entered.at(-1)).toEqual({});
    const supplied = fixture(tool, 'github-ticket');
    expect((await supplied.call({ reference: '322' })).isError).toBe(false);
    expect(supplied.entered.at(-1)).toEqual({ reference: '322' });
  });
}
