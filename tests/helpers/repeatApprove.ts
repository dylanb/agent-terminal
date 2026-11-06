// Approves a flow step's gate through the real approve path (`runAppApprove`) over a real flow manager, as a
// person's click does, so a test observes what an approve sources and where the flow goes next. Each step's
// loop is resolved from the tiers the test wrote it into; every side effect unrelated to sourcing is inert.

import { HUMAN_DECIDER, runAppApprove, stepScopedAdvance, type AppGateDecisionDeps, type GateApproveOutcome } from '../../src/main/appGateDecision';
import type { FlowManager } from '../../src/main/flow';
import { resolveLoopDefV2, type LoopDefV2Context } from '../../src/main/loopDefV2';
import type { FlowSpec } from './flowFixtures';

export interface AuditLine {
  cmd: string;
  exit: number | null;
}

export interface ApproveDriver {
  /** Approves the gate of `step`, the step the flow is on, as a person does. */
  approve(step: string): Promise<GateApproveOutcome>;
  /** The path the loop of `step` binds its output `id` to, as the resolved definition the engine reads gives it. */
  outputPath(step: string, id: string): string;
  /** Every §25 command entry the approves recorded, in order. */
  readonly audits: readonly AuditLine[];
}

/** `spec` is the flow the test wrote for `repoDir`; `sourceSliceCount` is the re-source dep under test. */
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
    refs: () => ({ pr: null, ticket: null, bootstrap: null }),
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
      const binding = resolved(step).def.outputs.find((o) => o.id === id);
      if (binding === undefined) throw new Error(`createApproveDriver: the loop of ${step} declares no output ${id}`);
      return binding.path;
    },
    audits,
  };
}
