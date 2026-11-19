import type { GateApproveOutcome, GateDecisionOutcome } from './appGateDecision';
import type { AutoGate } from './autoGate';
import { APPROVE_ALREADY_RUNNING, approveRunning, composeHumanApprove, humanApproveRefusal, type HumanApproveDeps } from './autoGateComposition';

export interface GateTarget { repoKey: string; step: string; turnKey: string }
export interface McpGateOperations {
  pickupHold(repo: string): string | null;
  refusal(target: GateTarget): string | null;
  approve(target: GateTarget, inputs?: Record<string, string>): Promise<GateApproveOutcome>;
  decide(target: GateTarget, option: 'request-changes' | 'redo' | 'polish', note?: string): Promise<GateDecisionOutcome>;
}

export function createMcpGateOperations(deps: HumanApproveDeps & {
  autoGate: Pick<AutoGate, 'humanDecision'>;
  decide: (repo: string, step: string, turn: string, option: 'request-changes' | 'redo' | 'polish', note?: string) => Promise<GateDecisionOutcome>;
}): McpGateOperations {
  const approve = composeHumanApprove(deps.autoGate, deps);
  return {
    pickupHold: deps.pickupHold,
    refusal: ({ repoKey, step, turnKey }) => approveRunning(deps.autoGate, repoKey, step, turnKey)
      ? APPROVE_ALREADY_RUNNING : humanApproveRefusal(deps, repoKey, step),
    approve: ({ repoKey, step, turnKey }, inputs) => approve(repoKey, step, turnKey, inputs),
    async decide({ repoKey, step, turnKey }, option, note) {
      const settled = deps.autoGate.humanDecision(repoKey, step, turnKey);
      let landed = false;
      try {
        const outcome = await deps.decide(repoKey, step, turnKey, option, note);
        landed = outcome.taken;
        return outcome;
      } finally { settled(landed); }
    },
  };
}
