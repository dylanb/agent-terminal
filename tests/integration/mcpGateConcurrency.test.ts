import { expect, it } from 'vitest';
import { createMcpActions } from '../../src/main/mcpActions';
import { HUMAN_DECIDER, runAppApprove, runAppGateDecisionOutcome } from '../../src/main/appGateDecision';
import { toolResult } from '../../src/main/mcpTools';
import type { McpWindowState } from '../../src/shared/mcpWindowState';
import { APPROVE_MARK_READY, mkDeps } from '../helpers/appGateDecisionDeps';

const target = { window: 'w', repo: '/repo', step: 'plan', turn: 'consolidate-plan' };
function state(): McpWindowState {
  return { window: { id: 'w' }, repo: { key: '/repo' }, flow: { selected: null, steps: ['plan'], step: 'plan', status: 'in_progress', runStarted: true }, selectionUnusable: false,
    gate: { step: target.step, turn: target.turn, options: ['approve', 'request-changes', 'redo', 'polish'], reasons: [], engineDeciding: false },
    stalledTurn: null, loopMessage: null, roundReport: null, todos: [], startable: null, startableError: null, terminateTodoCount: 0 };
}

it.each(['request_changes', 'redo', 'polish'])('%s refuses while approval side effects are pending', async tool => {
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const { deps, rec } = mkDeps({ holds: true, gate: [...APPROVE_MARK_READY, { option: 'request-changes', sideEffects: [] }, { option: 'redo', sideEffects: [] }, { option: 'polish', sideEffects: [] }],
    runSideEffect: async () => { entered(); await pending; return { outcome: 'done' }; } });
  const actions = createMcpActions({ windowId: 'w', originOf: async () => 'human', readState: async () => state(), readGateState: state,
    gate: { autoGate: { humanDecision: () => () => {} }, pickupHold: () => null, bindingOf: () => 'app',
      approve: (repo, step, turn) => runAppApprove(repo, step, turn, deps, HUMAN_DECIDER),
      decide: (repo, step, turn, option, note) => runAppGateDecisionOutcome(repo, step, turn, option, deps, note) } });
  const approving = actions.call({ tool: 'approve', args: target }, { session: 1 });
  await started;
  try {
    const result = toolResult({ kind: 'answered', value: await actions.call({ tool, args: { ...target, ...(tool === 'request_changes' ? { feedback: 'revise' } : tool === 'redo' ? { instruction: 'rebuild' } : {}) } }, { session: 2 }) });
    expect({ error: result.isError, text: result.content[0].text, feedback: rec.feedbacks, redo: rec.redos, polish: rec.polishEnters }).toEqual({ error: true, text: expect.stringMatching(/not valid.*approve.*running/is), feedback: [], redo: [], polish: [] });
  } finally { release(); await approving; }
});

it.each(['request_changes', 'redo', 'polish'])('%s reports no gate before a stale repository', async tool => {
  const current = state(); current.gate = null;
  const actions = createMcpActions({ windowId: 'w', originOf: async () => 'human', readState: async () => current, readGateState: () => current,
    gate: { autoGate: { humanDecision: () => () => {} }, pickupHold: () => null, bindingOf: () => 'app', approve: async () => ({ kind: 'advanced', effectFailures: [] }) } });
  const result = toolResult({ kind: 'answered', value: await actions.call({ tool, args: { ...target, repo: '/stale', ...(tool === 'request_changes' ? { feedback: 'revise' } : tool === 'redo' ? { instruction: 'rebuild' } : {}) } }, { session: 1 }) });
  expect({ error: result.isError, text: result.content[0].text }).toEqual({ error: true, text: expect.stringMatching(/no gate waiting/i) });
});
