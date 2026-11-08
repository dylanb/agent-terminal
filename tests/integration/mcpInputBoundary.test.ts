import { expect, it } from 'vitest';
import { createFlowMachine, type FlowLoad } from '../../src/main/flow';
import { createMcpActions } from '../../src/main/mcpActions';
import { toolResult } from '../../src/main/mcpTools';
import type { McpWindowState } from '../../src/shared/mcpWindowState';

it.each(['start', 'step', 'loop'] as const)('%s refuses undeclared input keys without changing saved values or progression', async mode => {
  const load: FlowLoad = { ok: true, flowDir: '/flow', definition: { name: 'entry', steps: [
    ...(mode === 'start' ? [] : [{ id: 'before', kind: 'manual' as const, inputs: [{ name: 'ticket', type: 'github-ticket', required: true }] }]),
    { id: 'entry', kind: 'manual' },
  ] } };
  const entered: Record<string, string>[] = [];
  const flow = createFlowMachine(load, undefined, (_step, values) => { entered.push({ ...values }); });
  if (mode !== 'start') flow.start({ startedAt: 1, inputs: { ticket: '322' } });
  const read = (): McpWindowState => ({ window: { id: 'w' }, repo: { key: '/repo' }, flow: { selected: null, steps: flow.state().steps, step: flow.state().stepName, status: flow.state().status, runStarted: mode !== 'start' }, selectionUnusable: false,
    gate: mode === 'start' ? null : { step: 'before', turn: mode === 'loop' ? 'consolidate' : null, options: ['approve'], reasons: [], engineDeciding: false },
    stalledTurn: null, loopMessage: null, roundReport: null, todos: [], startable: [], startableError: null, terminateTodoCount: 0 });
  const actions = createMcpActions({ windowId: 'w', originOf: async () => 'human', readState: async () => read(), readGateState: read,
    gate: { autoGate: { humanDecision: () => () => {} }, pickupHold: () => null, bindingOf: () => mode === 'loop' ? 'app' : null,
      approve: async (_repo, _step, _turn, inputs) => { flow.advance(inputs); return { kind: 'advanced', effectFailures: [] }; } },
    entryInputs: (_repo, action) => flow.entryInputs(action),
    start: (_repo, inputs) => { flow.start({ startedAt: 1, inputs }); return { kind: 'started' }; },
    advance: (_repo, _step, inputs) => { flow.advance(inputs); return { kind: 'advanced' }; },
  });
  const call = async (inputs: Record<string, string>) => toolResult({ kind: 'answered', value: await actions.call({ tool: mode === 'start' ? 'start' : 'approve', args: { window: 'w', repo: '/repo', ...(mode === 'start' ? {} : { step: 'before', ...(mode === 'loop' ? { turn: 'consolidate' } : {}) }), inputs } }, { session: 1 }) });
  const before = { state: flow.state(), entered: structuredClone(entered) };
  const result = await call({ ticket: '999' });
  expect({ error: result.isError, text: result.content[0].text, state: flow.state(), entered }).toEqual({ error: true, text: expect.stringMatching(/not valid.*ticket/is), ...before });
  expect((await call({})).isError).toBe(false);
  expect(entered.at(-1)).toEqual(mode === 'start' ? {} : { ticket: '322' });
});
