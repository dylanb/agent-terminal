// §18.7.2 / §18.7.4 / §25

import type { FlowLike } from '../shared/audit';
import type { FlowStateView, RebindChoice, RebindResult, StepMissingConsent } from '../shared/ipc';
import type { FlowManager } from './flow';
import type { HeldRunRecovery } from './heldRunRecovery';
import type { PendingNotices } from './pendingNotices';
import type { LockedResult, WorktreeLock } from './worktreeLock';
import { errMsg } from './errno';

export type LifecycleTerminateResult =
  | { outcome: 'reset'; view: FlowStateView }
  | { outcome: 'refused'; cause: 'not-begun'; view: FlowStateView }
  | { outcome: 'refused'; cause: 'locked' | 'failed'; reason: string; view: FlowStateView };

export interface FlowLifecycleDeps {
  lock: Pick<WorktreeLock, 'withWorktreeLock'>;
  flow: Pick<FlowManager, 'terminate' | 'state' | 'revertStep'>;
  recovery: Pick<HeldRunRecovery, 'rebind'>;
  pendingNotices: Pick<PendingNotices, 'post'>;
  /** An app-loop turn bound to the run's current definition is in flight for the worktree. */
  loopTurnActive(repoKey: string): boolean;
  /** Drop the runtime state issued under the run's current binding. */
  forgetRunEntry(repoKey: string): void;
  /** §27.9.1 — end the engine-held run: called on every reset of the run to not_started. */
  endRun(repoKey: string): void;
  recordTerminate(repoKey: string): void;
  recordRollback(repoKey: string, before: FlowLike, after: FlowLike): void;
  clearTodos(repoKey: string): void;
  clearSliceBrief(repoKey: string): void;
  clearMonitor(): void;
  flowChanged(): void;
  /** §27.12 — the run ended, so a stalled loop turn for the worktree must not resume on a late done-signal. */
  releaseLoopTurn(repoKey: string): void;
  presentView(repoKey: string, view: FlowStateView): FlowStateView;
}

export interface FlowLifecycle {
  terminate(repoKey: string): LifecycleTerminateResult;
  /** A Terminate with no renderer to show its reply: a locked or failed refusal's reason rides the next
   *  `flow:state` instead. */
  terminateUnattended(repoKey: string): LifecycleTerminateResult;
  rebind(repoKey: string, choice: RebindChoice, ifStepMissing: StepMissingConsent): RebindResult;
  /** Roll a failed step bootstrap back under the worktree lock; throws when the lock or the rollback refuses it. */
  rollbackStep(repoKey: string, stepId: string): FlowStateView;
}

const ACTIVE_TURN_REASON =
  'A loop turn is running for this worktree; let it finish, or Terminate the run, before recovering it onto a flow.';

const ROLLBACK_FAILED_REMEDY = 'The step was not rolled back; Terminate the run to end it.';

function bestEffort(effect: () => void): void {
  try {
    effect();
  } catch (e) {
    console.error('flow lifecycle side effect failed:', errMsg(e));
  }
}

export function createFlowLifecycle(deps: FlowLifecycleDeps): FlowLifecycle {
  const afterTerminateReset = (repoKey: string): void => {
    bestEffort(() => deps.forgetRunEntry(repoKey));
    bestEffort(() => deps.endRun(repoKey));
    bestEffort(() => deps.releaseLoopTurn(repoKey));
    bestEffort(() => deps.recordTerminate(repoKey));
    bestEffort(() => deps.clearTodos(repoKey));
    bestEffort(() => deps.clearSliceBrief(repoKey));
    bestEffort(() => deps.clearMonitor());
    bestEffort(() => deps.flowChanged());
  };

  const terminate = (repoKey: string): LifecycleTerminateResult => {
    const locked = deps.lock.withWorktreeLock(repoKey, () => deps.flow.terminate(repoKey));
    if (!locked.ok) {
      const { reason } = locked;
      return { outcome: 'refused', cause: 'locked', reason, view: deps.presentView(repoKey, { ...deps.flow.state(repoKey), notice: reason }) };
    }
    const result = locked.value;
    const view = deps.presentView(repoKey, result.view);
    if (result.outcome === 'reset') {
      afterTerminateReset(repoKey);
      return { outcome: 'reset', view };
    }
    return result.cause === 'failed'
      ? { outcome: 'refused', cause: 'failed', reason: result.reason, view }
      : { outcome: 'refused', cause: 'not-begun', view };
  };

  return {
    terminate,
    terminateUnattended(repoKey) {
      const result = terminate(repoKey);
      if (result.outcome === 'refused' && result.cause !== 'not-begun') {
        deps.pendingNotices.post(repoKey, result.reason);
        bestEffort(() => deps.flowChanged());
      }
      return result;
    },
    rollbackStep(repoKey, stepId) {
      let locked: LockedResult<{ before: FlowStateView; after: FlowStateView }>;
      try {
        locked = deps.lock.withWorktreeLock(repoKey, () => {
          const before = deps.flow.state(repoKey);
          return { before, after: deps.flow.revertStep(repoKey, stepId) };
        });
      } catch (e) {
        bestEffort(() => deps.flowChanged());
        throw new Error(`${errMsg(e)} ${ROLLBACK_FAILED_REMEDY}`);
      }
      if (!locked.ok) throw new Error(`${locked.reason} ${ROLLBACK_FAILED_REMEDY}`);
      const { before, after } = locked.value;
      bestEffort(() => deps.recordRollback(repoKey, before, after));
      if (after.status === 'not_started') bestEffort(() => deps.endRun(repoKey));
      return after;
    },
    rebind(repoKey, choice, ifStepMissing) {
      if (deps.loopTurnActive(repoKey)) return { ok: false, reason: ACTIVE_TURN_REASON };
      const result = deps.recovery.rebind(repoKey, choice, ifStepMissing);
      if (!result.ok) return result;
      if (result.outcome === 'terminated') {
        afterTerminateReset(repoKey);
        return result;
      }
      bestEffort(() => deps.forgetRunEntry(repoKey));
      bestEffort(() => deps.flowChanged());
      return result;
    },
  };
}
