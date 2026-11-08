import { expect, it } from 'vitest';
import { createFlowMachine } from '../../src/main/flow';
import { createMcpActions } from '../../src/main/mcpActions';
import { readWindowState } from '../../src/main/mcpWindowState';
import { invalidToolArguments, toolResult } from '../../src/main/mcpTools';
import type { McpWindowState } from '../../src/shared/mcpWindowState';

it('approves the step-gate target returned by read_state including its null turn', async () => {
  const flow = createFlowMachine({ ok: true, flowDir: '/flow', definition: { name: 'manual', steps: [{ id: 'first', kind: 'manual' }, { id: 'next', kind: 'manual' }] } });
  flow.start();
  const read = () => readWindowState({ windowId: 'window', repoKey: '/repo', view: { ...flow.state(), runStarted: 'started' }, selectedFlow: null, loopMessage: null, todos: [], latestRoundReport: null, startable: [] });
  const actions = createMcpActions({ windowId: 'window', originOf: async () => 'human', readState: async () => read(), readGateState: read,
    gate: { autoGate: { humanDecision: () => () => {} }, pickupHold: () => null, bindingOf: () => null, approve: async () => ({ kind: 'advanced', effectFailures: [] }) },
    advance: () => { flow.advance(); return { kind: 'advanced' }; } });
  const state = await actions.call({ tool: 'read_state', args: {} }, { session: 1 }) as McpWindowState;
  const result = toolResult({ kind: 'answered', value: await actions.call({ tool: 'approve', args: { window: state.window.id, repo: state.repo!.key, step: state.gate!.step, turn: state.gate!.turn } }, { session: 1 }) });
  expect({ error: result.isError, step: flow.state().stepName }).toEqual({ error: false, step: 'next' });
});

it('does not interpret a null turn as the identity of a loop gate', async () => {
  let advanced = false;
  const state: McpWindowState = { window: { id: 'window' }, repo: { key: '/repo' }, flow: null, selectionUnusable: false,
    gate: { step: 'plan', turn: 'consolidate-plan', options: ['approve'], reasons: [], engineDeciding: false },
    stalledTurn: null, loopMessage: null, roundReport: null, todos: [], startable: null, startableError: null, terminateTodoCount: null };
  const actions = createMcpActions({ windowId: 'window', originOf: async () => 'human', readState: async () => state, readGateState: () => state,
    gate: { autoGate: { humanDecision: () => () => {} }, pickupHold: () => null, bindingOf: () => 'app', approve: async () => { advanced = true; return { kind: 'advanced', effectFailures: [] }; } } });
  const result = toolResult({ kind: 'answered', value: await actions.call({ tool: 'approve', args: { window: 'window', repo: '/repo', step: 'plan', turn: null } }, { session: 1 }) });
  expect({ error: result.isError, advanced }).toEqual({ error: true, advanced: false });
});

it.each(['request_changes', 'redo', 'polish', 'retry'])('%s still requires a string turn identity', tool => {
  expect(invalidToolArguments(tool, { window: 'window', repo: '/repo', step: 'plan', turn: null, ...(tool === 'request_changes' ? { feedback: 'revise' } : tool === 'redo' ? { instruction: 'revise' } : {}) })).toMatch(/turn/);
});
