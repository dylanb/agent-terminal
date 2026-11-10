// §27.9.1 — the wiring `index.ts` composes around the gate controller, as importable factories so the
// integration tests drive the production composition rather than a copy of it.

import type { FlowStateView } from '../shared/ipc';
import type { TransitionKind } from '../shared/audit';
import { runAppApprove, type AppGateDecisionDeps, type ApproveDecider, type GateApproveOutcome } from './appGateDecision';
import type { AuditRecorder } from './auditRecorder';
import { type AutoGate, type AutoGateDeps, type StartRun } from './autoGate';
import { resolveLoopDefV2, type LoopDefV2Context, type LoopDefV2Result } from './loopDefV2';
import type { LoopBinding } from '../shared/loopNamespace';
import { markedBindingRefusal, type GateDecisionRun } from './gateDecisionGuard';
import { createBoundSourceLoader } from './runResolver';
import type { LoopDefV2Tiers } from './loopDefV2';
import { createFlowStateStore } from './flowState';
import { readRunBinding } from './runDisposition';

export type ObservedResolveDef = (repoDir: string, name: string) => LoopDefV2Result;
export type RecordFlowTransition = AuditRecorder['recordTransition'];

export interface StartTransitionDeps {
  autoGate: AutoGate;
  /** The one resolution the Start acts on; null when the flow does not load (the Start then binds nothing). */
  resolveForStart: (repoKey: string) => StartRun | null;
  start: (repoKey: string, opts: { startedAt: number; run?: StartRun }) => FlowStateView;
  now: () => number;
  record: RecordFlowTransition;
}

/** The `flowStart` transition: one clock read and one resolution, bound before the first step is entered. */
export function composeStartTransition(deps: StartTransitionDeps): (repoKey: string) => FlowStateView {
  return (repoKey) => {
    const startedAt = deps.now();
    const run = deps.resolveForStart(repoKey);
    if (run === null) return deps.start(repoKey, { startedAt });
    deps.autoGate.bindAtStart(repoKey, run, startedAt);
    let view: FlowStateView;
    try {
      view = deps.start(repoKey, { startedAt, run });
    } catch (e) {
      deps.autoGate.discardStart(repoKey);
      throw e;
    }
    if (view.status !== 'in_progress') {
      deps.autoGate.discardStart(repoKey);
      return view;
    }
    deps.autoGate.commitStart(repoKey);
    deps.record(repoKey, 'start', { status: 'not_started', stepName: '' }, view, { startedAt, flow: run.definition.name });
    return view;
  };
}

/** The one def resolver every production resolution goes through. */
export function composeObservedResolveDef(ctxFor: (repoDir: string) => LoopDefV2Context): ObservedResolveDef {
  return (repoDir, name) => resolveLoopDefV2(name, ctxFor(repoDir));
}

/** The loop-step entry's resolution: a fresh loop run begins before its first resolution. */
export function composeLoopBindingResolve(autoGate: AutoGate, observedResolveDef: ObservedResolveDef): (repoKey: string, step: string, name: string) => LoopDefV2Result {
  return (repoKey, step, name) => {
    autoGate.beginLoopRun(repoKey, step);
    return observedResolveDef(repoKey, name);
  };
}

/** The engine's approve: the human approve's marked-binding refusal and its per-worktree deps. */
export function composeEngineApprove(
  approveDepsFor: (repoKey: string) => AppGateDecisionDeps,
  bindingOf: (repoKey: string, step: string) => LoopBinding | null,
): (repoDir: string, step: string, turnKey: string, decider: ApproveDecider) => Promise<GateApproveOutcome> {
  return async (repoDir, step, turnKey, decider) => {
    const refusal = markedBindingRefusal(bindingOf, repoDir, step);
    if (refusal !== null) return { kind: 'refused', reason: refusal };
    return runAppApprove(repoDir, step, turnKey, approveDepsFor(repoDir), decider);
  };
}

/** Every flow transition's §25 record; the run end it reaches reports a failed-effect marker (§27.9.1 N9b.5(d)). */
export function composeRecordFlowTransition(audit: Pick<AuditRecorder, 'recordTransition'>, autoGate: AutoGate): RecordFlowTransition {
  return (repoKey: string, kind: TransitionKind, before, after, start) => {
    audit.recordTransition(repoKey, kind, before, after, start);
    autoGate.flowTransitioned(repoKey, after);
  };
}

/** The flow lifecycle's run-end: every reset to not_started ends the engine-held run. */
export function composeLifecycleEndRun(autoGate: AutoGate): (repoKey: string) => void {
  return (repoKey) => autoGate.endRun(repoKey);
}

export function composeCurrentRun(globalRoot: string, defTiers: LoopDefV2Tiers): AutoGateDeps['currentRun'] {
  const loadBound = createBoundSourceLoader(globalRoot, defTiers);
  return (repoDir) => {
    const binding = readRunBinding(repoDir);
    if (binding === null) return null;
    const load = loadBound(repoDir, binding);
    return load.ok ? { definition: load.definition, binding } : null;
  };
}

export function composeRunInProgressAt(): AutoGateDeps['runInProgressAt'] {
  return (repoDir, step) => {
    const persisted = createFlowStateStore(repoDir).read();
    return persisted !== null && persisted.status === 'in_progress' && persisted.step === step;
  };
}

export interface HumanDecisionRunnerDeps<View> {
  decide: GateDecisionRun;
  advance: (repoKey: string) => View;
  currentStep: (repoKey: string) => string | null;
}

export interface HumanDecisionRunners<View> {
  decide: GateDecisionRun;
  /** The strip's manual Advance; null when it was refused. */
  advance: (repoKey: string, step: string | undefined) => View | null;
}

/** The four gate-decision runners and the manual Advance, as the human decides them (§27.9.1 N9b.5(d)/(e)). */
export function composeHumanDecisionRunners<View>(autoGate: AutoGate, deps: HumanDecisionRunnerDeps<View>): HumanDecisionRunners<View> {
  return {
    decide: async (repoKey, step, turnKey, option, note) => {
      const settled = autoGate.humanDecision(repoKey, step, turnKey);
      let landed = false;
      try {
        landed = await deps.decide(repoKey, step, turnKey, option, note);
        return landed;
      } finally {
        settled(landed);
      }
    },
    advance: (repoKey, named) => {
      const step = deps.currentStep(repoKey);
      if (step === null || (named !== undefined && named !== step)) return null;
      const settled = autoGate.humanDecision(repoKey, step, null);
      let landed = false;
      try {
        const view = deps.advance(repoKey);
        landed = true;
        return view;
      } finally {
        settled(landed);
      }
    },
  };
}
