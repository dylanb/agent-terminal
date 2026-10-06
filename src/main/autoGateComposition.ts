import type { FlowStateView } from '../shared/ipc';
import type { TransitionKind } from '../shared/audit';
import { runAppApprove, type AppGateDecisionDeps, type ApproveDecider, type GateApproveOutcome } from './appGateDecision';
import type { AuditRecorder } from './auditRecorder';
import type { AutoGate, AutoGateDeps, StartRun } from './autoGate';
import { resolveLoopDefV2, type LoopDefV2Context, type LoopDefV2Result } from './loopDefV2';
import type { LoopBinding } from '../shared/loopNamespace';

export type ObservedResolveDef = (repoDir: string, name: string) => LoopDefV2Result;
export type RecordFlowTransition = AuditRecorder['recordTransition'];

export interface StartTransitionDeps {
  autoGate: AutoGate;
  resolveForStart: (repoKey: string) => StartRun;
  start: (repoKey: string, opts: { startedAt: number; run: StartRun }) => FlowStateView;
  now: () => number;
  record: RecordFlowTransition;
  captureTimeoutMs: number;
}

export function composeStartTransition(deps: StartTransitionDeps): (repoKey: string) => FlowStateView {
  return (repoKey) => deps.start(repoKey, { startedAt: deps.now(), run: deps.resolveForStart(repoKey) });
}

export function composeObservedResolveDef(_autoGate: AutoGate, ctxFor: (repoDir: string) => LoopDefV2Context): ObservedResolveDef {
  return (repoDir, name) => resolveLoopDefV2(name, ctxFor(repoDir));
}

export function composeLoopBindingResolve(_autoGate: AutoGate, observedResolveDef: ObservedResolveDef): (repoKey: string, step: string, name: string) => LoopDefV2Result {
  return (repoKey, _step, name) => observedResolveDef(repoKey, name);
}

export function composeEngineApprove(
  approveDepsFor: (repoKey: string) => AppGateDecisionDeps,
  _bindingOf: (repoKey: string, step: string) => LoopBinding | null,
): (repoDir: string, step: string, turnKey: string, decider: ApproveDecider) => Promise<GateApproveOutcome> {
  return (repoDir, step, turnKey, decider) => runAppApprove(repoDir, step, turnKey, approveDepsFor(repoDir), decider);
}

export function composeRecordFlowTransition(audit: Pick<AuditRecorder, 'recordTransition'>, _autoGate: AutoGate): RecordFlowTransition {
  return (repoKey: string, kind: TransitionKind, before, after, start) => audit.recordTransition(repoKey, kind, before, after, start);
}

export function composeLifecycleEndRun(_autoGate: AutoGate): (repoKey: string) => void {
  return () => {};
}

export function composeCurrentRun(_globalRoot: string): AutoGateDeps['currentRun'] {
  return () => null;
}

export function composeRunInProgressAt(): AutoGateDeps['runInProgressAt'] {
  return () => false;
}
