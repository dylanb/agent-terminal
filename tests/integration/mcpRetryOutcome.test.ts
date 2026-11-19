import { afterEach, beforeEach, expect, it } from 'vitest';
import { mcpActions as createMcpActions, testGateOperations } from '../helpers/mcpActions';
import { writeAppLoopState } from '../../src/main/appLoopState';
import { toolResult } from '../../src/main/mcpTools';
import type { McpWindowState } from '../../src/shared/mcpWindowState';
import { createAppLoopEngineHarness, FIXED, STEP, TURN_KEY, REVIEW_KEY } from '../helpers/appLoopEngineHarness';

const h = createAppLoopEngineHarness();
beforeEach(h.setUp);
afterEach(h.tearDown);

it.each([TURN_KEY, REVIEW_KEY])('reports a refused %s retry and accepts a later repaired retry', async turn => {
  writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: turn, status: 'error', errorReason: 'stalled', ...(turn === REVIEW_KEY ? { round: 2 } : {}) }, FIXED);
  const engine = h.makeEngine();
  engine.resume(h.repo);
  const good = h.defResult;
  const state: McpWindowState = { window: { id: 'w' }, repo: { key: h.repo }, flow: null, selectionUnusable: false, gate: null,
    stalledTurn: { step: STEP, turn, reason: 'stalled' }, loopMessage: null, roundReport: null, todos: [], startable: null, startableError: null, terminateTodoCount: null };
  const actions = createMcpActions({ windowId: 'w', originOf: async () => 'human', readState: async () => state, readActionState: () => state,
    gate: testGateOperations({ pickupHold: () => null, approve: async () => ({ kind: 'advanced', effectFailures: [] }) }),
    retry: (repo, step, key) => engine.retry(repo, step, key) });
  const retry = async () => toolResult({ kind: 'answered', value: await actions.call({ tool: 'retry', args: { window: 'w', repo: h.repo, step: STEP, turn } }, { session: 1 }) });
  h.defResult = { ok: false, reason: 'definition removed' };
  const before = h.injected.length;
  const refused = await retry();
  expect({ error: refused.isError, text: refused.content[0].text, injected: h.injected.length }).toEqual({ error: true, text: expect.stringMatching(/no longer resolves/), injected: before });
  h.defResult = good;
  const repaired = await retry();
  engine.onInjectable();
  engine.onInjectable();
  expect(repaired.isError).not.toBe(true);
  expect(h.injected.length).toBeGreaterThan(before);
});

it('retry returns an explicit refusal for a stale turn without injecting work', () => {
  const engine = h.makeEngine();
  const before = h.injected.length;
  expect(engine.retry(h.repo, STEP, TURN_KEY)).toEqual({ taken: false, reason: 'the stopped turn no longer matches' });
  expect(h.injected.length).toBe(before);
});
