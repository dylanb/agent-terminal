import { expect, it } from 'vitest';
import { createFlowMachine } from '../../src/main/flow';
import { mcpActions as createMcpActions, testGateOperations } from '../helpers/mcpActions';
import { readWindowState } from '../../src/main/mcpWindowState';
import { invalidToolArguments, toolResult } from '../../src/main/mcpTools';
import type { McpWindowState } from '../../src/shared/mcpWindowState';

it('approves the step-gate target returned by read_state including its null turn', async () => {
  const flow = createFlowMachine({ ok: true, flowDir: '/flow', definition: { name: 'manual', steps: [{ id: 'first', kind: 'manual' }, { id: 'next', kind: 'manual' }] } });
  flow.start();
  const read = () => readWindowState({ windowId: 'window', repoKey: '/repo', view: { ...flow.state(), runStarted: 'started' }, selectedFlow: null, loopMessage: null, todos: [], latestRoundReport: null, startable: [] });
  const actions = createMcpActions({ windowId: 'window', originOf: async () => 'human', readState: async () => read(), readActionState: read,
    gate: testGateOperations({ pickupHold: () => null, approve: async () => ({ kind: 'advanced', effectFailures: [] }) }),
    advance: () => { flow.advance(); return { kind: 'taken', message: 'Taken.' }; } });
  const state = await actions.call({ tool: 'read_state', args: {} }, { session: 1 }) as McpWindowState;
  const result = toolResult({ kind: 'answered', value: await actions.call({ tool: 'approve', args: { window: state.window.id, repo: state.repo!.key, step: state.gate!.step, turn: state.gate!.turn } }, { session: 1 }) });
  expect({ error: result.isError, step: flow.state().stepName }).toEqual({ error: false, step: 'next' });
});

it('does not interpret a null turn as the identity of a loop gate', async () => {
  let advanced = false;
  const state: McpWindowState = { window: { id: 'window' }, repo: { key: '/repo' }, flow: null, selectionUnusable: false,
    gate: { step: 'plan', turn: 'consolidate-plan', options: ['approve'], reasons: [], engineDeciding: false },
    stalledTurn: null, loopMessage: null, roundReport: null, todos: [], startable: null, startableError: null, terminateTodoCount: null };
  const actions = createMcpActions({ windowId: 'window', originOf: async () => 'human', readState: async () => state, readActionState: () => state,
    gate: testGateOperations({ pickupHold: () => null, approve: async () => { advanced = true; return { kind: 'advanced', effectFailures: [] }; } }) });
  const result = toolResult({ kind: 'answered', value: await actions.call({ tool: 'approve', args: { window: 'window', repo: '/repo', step: 'plan', turn: null } }, { session: 1 }) });
  expect({ error: result.isError, advanced }).toEqual({ error: true, advanced: false });
});

it.each(['request_changes', 'redo', 'polish', 'retry'])('%s still requires a string turn identity', tool => {
  expect(invalidToolArguments(tool, { window: 'window', repo: '/repo', step: 'plan', turn: null, ...(tool === 'request_changes' ? { feedback: 'revise' } : tool === 'redo' ? { instruction: 'revise' } : {}) })).toMatch(/turn/);
});

it('validates and saves inputs for the selected branch, excluding skipped steps', () => {
  let entered: Record<string, string> = {};
  const flow = createFlowMachine({ ok: true, flowDir: '/flow', definition: { name: 'branch', steps: [
    { id: 'choice', kind: 'manual', decides: ['left', 'right'] },
    { id: 'left', kind: 'manual', when: { step: 'choice', value: 'left' }, inputs: [{ name: 'leftValue', type: 'string', required: true }] },
    { id: 'right', kind: 'manual', when: { step: 'choice', value: 'right' }, inputs: [{ name: 'rightValue', type: 'string', required: true }] },
  ] } }, undefined, (_step, inputs) => { entered = inputs; });
  flow.start();
  flow.recordDecision('choice', { value: 'right' });
  expect(flow.validateEntryInputs('approve', { rightValue: 'chosen' })).toEqual({ valid: true });
  const result = flow.advance({ rightValue: 'chosen' });
  expect(result.stepName).toBe('right');
  expect(entered).toEqual({ rightValue: 'chosen' });
});

it('preflights a pending gate decision without recording it or advancing the flow', () => {
  const flow = createFlowMachine({ ok: true, flowDir: '/flow', definition: { name: 'pending', steps: [
    { id: 'choice', kind: 'manual', decides: ['left', 'right'] },
    { id: 'left', kind: 'manual', when: { step: 'choice', value: 'left' }, inputs: [{ name: 'leftValue', type: 'string', required: true }] },
    { id: 'right', kind: 'manual', when: { step: 'choice', value: 'right' }, inputs: [{ name: 'rightValue', type: 'string', required: true }] },
  ] } });
  flow.start();
  expect(flow.validateEntryInputs('approve', { rightValue: 'chosen' }, { value: 'right' })).toEqual({ valid: true });
  expect(flow.state().decisions).toEqual({});
  expect(flow.advance().stepName).toBe('choice');
});
