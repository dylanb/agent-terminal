import { HUMAN_DECIDER, runAppApprove, stepScopedAdvance, type AppGateDecisionDeps, type GateApproveOutcome } from '../../src/main/appGateDecision';
import type { FlowManager } from '../../src/main/flow';
import { resolveLoopDefV2, type LoopDefV2Context } from '../../src/main/loopDefV2';
import { outputLocation } from '../../src/main/appWorkTurn';
import type { FlowSpec } from './flowFixtures';

export interface AuditLine {
  cmd: string;
  exit: number | null;
}

export interface ApproveDriver {
  approve(step: string): Promise<GateApproveOutcome>;
  outputPath(step: string, id: string): string;
  readonly audits: readonly AuditLine[];
}

export function createApproveDriver(opts: {
  repoDir: string;
  flow: FlowManager;
  spec: FlowSpec;
  loops: LoopDefV2Context;
  sourceSliceCount: AppGateDecisionDeps['sourceSliceCount'];
}): ApproveDriver {
  const { repoDir, flow, spec, loops } = opts;
  const audits: AuditLine[] = [];
  const loopOf = (step: string): string => {
    const found = spec.steps.find((s) => s.id === step);
    if (found?.kind !== 'loop') throw new Error(`createApproveDriver: ${step} is not a loop step of ${spec.name}`);
    return found.loop;
  };
  const resolved = (step: string) => {
    const r = resolveLoopDefV2(loopOf(step), loops);
    if (!r.ok) throw new Error(`createApproveDriver: the loop of ${step} does not resolve: ${r.reason}`);
    return r;
  };
  let gateStep = '';
  const deps: AppGateDecisionDeps = {
    readRunState: () => ({ loop: loopOf(gateStep), step: gateStep, turnKey: `work-${gateStep}`, status: 'complete', round: 1, verdict: 'clean' }),
    resolveDef: (_repoDir, loopName) => resolveLoopDefV2(loopName, loops),
    refs: () => ({ pr: null, ticket: null, pickup: null }),
    runSideEffect: async () => ({ outcome: 'done' }),
    runCommitSideEffect: async () => ({ outcome: 'nothing-to-commit' }),
    runPushSideEffect: async () => {},
    failureHoldsGate: () => false,
    persistAccept: () => {},
    assembleReport: () => {},
    advanceFlow: stepScopedAdvance(
      (r) => flow.state(r).stepName,
      (r) => {
        if (flow.state(r).status === 'in_progress') flow.advance(r);
      },
    ),
    sourceSliceCount: opts.sourceSliceCount,
    reopenSlice: () => false,
    recordSliceBrief: () => {},
    clearSliceBrief: () => {},
    reopenStep: () => null,
    maybeBeginEpicPromotion: () => ({ kind: 'not-epic' }),
    deliverFeedback: () => false,
    deliverRedo: () => false,
    enterPolish: () => {},
    clearPolish: () => {},
    audit: (_r, cmd, exit) => void audits.push({ cmd, exit }),
    emitError: () => {},
    emitNotice: () => {},
    recordBaseline: () => {},
    onViewChanged: () => {},
  };
  return {
    approve(step) {
      const at = flow.state(repoDir).stepName;
      if (at !== step) throw new Error(`createApproveDriver: the flow is on ${at}, not ${step}`);
      resolved(step);
      gateStep = step;
      return runAppApprove(repoDir, step, `work-${step}`, deps, HUMAN_DECIDER);
    },
    outputPath(step, id) {
      const at = outputLocation(resolved(step).def, id, flow.currentSlice(repoDir));
      if (at === null) throw new Error(`createApproveDriver: the loop of ${step} declares no output ${id}`);
      return at.path;
    },
    audits,
  };
}
