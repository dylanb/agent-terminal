import { expect, it } from 'vitest';
import { createMcpGateOperations } from '../../src/main/mcpGateOperations';
import { HUMAN_DECIDER, runAppApprove } from '../../src/main/appGateDecision';
import { mkDeps } from '../helpers/appGateDecisionDeps';

it('completes approval through a domain operation without exposing its coordination to the caller', async () => {
  const { deps, rec } = mkDeps({ holds: false });
  const gate = createMcpGateOperations({
    autoGate: { humanDecision: () => () => {} }, pickupHold: () => null, bindingOf: () => 'app',
    approve: (repo, step, turn) => runAppApprove(repo, step, turn, deps, HUMAN_DECIDER),
    decide: async () => ({ taken: false, reason: 'not waiting' }),
  });
  const target = { repoKey: '/repo', step: 'plan', turnKey: 'consolidate-plan' };
  expect(gate.refusal(target)).toBe(null);
  expect(await gate.approve(target)).toMatchObject({ kind: 'advanced' });
  expect(rec.accepts.length).toBeGreaterThan(0);
});
